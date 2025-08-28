// server.js
const express = require('express');
const session = require('express-session');
const fs = require('fs-extra');
const { IncomingForm } = require('formidable');
const os = require('os');
const path = require('path');
const pidusage = require('pidusage');
const http = require('http');
const { Server } = require('socket.io');
const ProcessManager = require('./ProcessManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    path: '/socket.io'
});

const PORT = 3001;
const INSTANCE_FILE = './instances.json';

// In-memory data
const SOCKETS = {};
let instances = {};
const instanceLogs = {};
const logs = {};
const pm = new ProcessManager();

// Load instances on startup
if (fs.existsSync(INSTANCE_FILE)) {
    instances = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf-8'));
}

function saveInstances() {
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify(instances, null, 2), 'utf-8');
}

function waitUntilStopped(name, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const interval = 250;
        let waited = 0;

        const check = () => {
            if (!instances[name] || instances[name].status === "stopped") {
                return resolve();
            }
            waited += interval;
            if (waited >= timeoutMs) {
                return reject(new Error(`Instance ${name} did not stop in time.`));
            }
            setTimeout(check, interval);
        };

        check();
    });
}

// Check if PID is running
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function appendInstanceLog(name, text, io) {
    if (!instanceLogs[name]) {
        instanceLogs[name] = [];
    }

    const lines = text.split(/\r?\n/);
    for (let line of lines) {
        if (line.trim() === "") continue; // skip empty lines
        instanceLogs[name].push(line);
    }

    // Trim to max 400 lines
    while (instanceLogs[name].length > 400) {
        instanceLogs[name].shift();
    }

    // Emit log lines to clients
    io.to(name).emit("log", { instance: name, text });
}

function getFileRoot(instanceName) {
    const inst = instances[instanceName];
    if (!inst) {
        throw new Error(`Instance not found: ${instanceName}`);
    }
    return inst.workingDir;
}

function safePath(basePath, relPath) {
    const abs = path.resolve(basePath, relPath);
    if (!abs.startsWith(path.resolve(basePath))) {
        throw new Error('Access denied: Path traversal attempt.');
    }
    return abs;
}


// Initial instance check
for (const name in instances) {
    const inst = instances[name];
    if (inst.pid && isPidRunning(inst.pid)) {
        inst.status = "running";
    } else {
        inst.status = "stopped";
        inst.pid = null;
    }
}
saveInstances();

// Update status every 10s
setInterval(() => {
    let changed = false;
    for (const name in instances) {
        const inst = instances[name];
        const wasRunning = inst.status === "running";
        const isRunningNow = inst.pid && isPidRunning(inst.pid);
        if (wasRunning !== isRunningNow) {
            inst.status = isRunningNow ? "running" : "stopped";
            if (!isRunningNow) inst.pid = null;
            changed = true;
        }
    }
    if (changed) {
        saveInstances();
        io.emit('instancesStatus', instances);
    }
}, 10000);

const sessionMiddleware = session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
});
const wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

app.use(sessionMiddleware);
io.use(wrap(sessionMiddleware));

app.use(express.static('public'));
app.use(express.json());
const router = express.Router();
app.use('/api', router);

// Start server with detached process
async function startServer(name, io) {
    const instance = instances[name];
    if (!instance) throw new Error('Instance not found');

    const [command, ...args] = instance.command.split(' ');

    let cmdToRun;
    const fullPath = path.join(instance.workingDir, command);

    if (await fs.pathExists(fullPath)) {
        // Command exists locally in workingDir
        cmdToRun = fullPath;
    } else {
        // Assume it's in PATH
        cmdToRun = command;
    }

    console.log(`Starting instance ${name} using: ${cmdToRun} ${args.join(' ')}`);

    const id = pm.spawnProcess(cmdToRun, args, {
        cwd: instance.workingDir
    });

    const procInfo = pm.processes.get(id);

    if (!procInfo || !procInfo.pid) {
        throw new Error(`Failed to start process for ${name}`);
    }
    procInfo.proc.stdout.on('data', data => {
        const text = data.toString();
        appendInstanceLog(name, text, io);
    });

    procInfo.proc.stderr.on('data', data => {
        const text = data.toString();
        appendInstanceLog(name, text, io);
    });

    instance.pid = procInfo.pid;
    instance.status = "running";
    saveInstances();
    io.to(name).emit('statusUpdate', { instance: name, status: 'running' });


    return procInfo.pid;
}
// Stop instance sending stop command
async function stopServer(name) {
    const instance = instances[name];
    if (!instance || !instance.pid) throw new Error('Instance not running');

    const found = [...pm.processes.values()].find(p => p.pid === instance.pid);
    if (!found || !found.proc) throw new Error('Process info not found');

    const proc = found.proc;

    return new Promise((resolve, reject) => {
        let stopped = false;

        try {
            // Send "stop" to stdin
            proc.stdin.write('stop\n');
        } catch (err) {
            return reject(new Error('Failed to send stop command: ' + err.message));
        }

        // Wait up to 5 seconds for clean exit
        const timeout = setTimeout(() => {
            if (!stopped) {
                proc.kill('SIGKILL'); // Force kill if still running
                cleanup();
                resolve();
            }
        }, 60000 * 5);

        const cleanup = () => {
            clearTimeout(timeout);
            instance.status = "stopped";
            instance.pid = null;
            pm.processes.delete(found.id);
            saveInstances();
            resolve();
        };

        proc.once('exit', (code) => {
            stopped = true;
            cleanup();
        });
    });
}
// call stopserver then wait until stopped, then startserver
async function restartServer(name, io) {
    await stopServer(name);

    // Wait until the instance is fully stopped
    await waitUntilStopped(name, 5000);

    return await startServer(name, io);
}
// just kill process
function terminateInstance(name) {
    const instance = instances[name];
    if (!instance || !instance.pid) return;

    const found = [...pm.processes.values()].find(p => p.pid === instance.pid);
    if (found) pm.killProcess(found.id);

    instance.status = "terminated";
    instance.pid = null;
    saveInstances();
}

// ------------------- REST ROUTES -----------------------------

router.get('/system', (req, res) => {
    const usage = {
        cpu: os.loadavg()[0] * 100,
        memoryUsedMB: (os.totalmem() - os.freemem()) / (1024 * 1024),
        memoryTotalMB: os.totalmem() / (1024 * 1024)
    };
    res.json(usage);
});

router.get('/instances', async (req, res) => {
    const info = {};
    const promises = [];

    for (const [name, inst] of Object.entries(instances)) {
        const proc = processes[name];
        if (proc) {
            const pid = proc.pid;
            const promise = pidusage(pid)
                .then(stats => {
                    info[name] = {
                        name,
                        status: 'Running',
                        pid,
                        workingDir: inst.workingDir,
                        command: inst.command,
                        cpu: stats.cpu,
                        memory: stats.memory / 1024 / 1024
                    };
                })
                .catch(() => {
                    info[name] = {
                        name,
                        status: 'Unknown',
                        pid,
                        workingDir: inst.workingDir,
                        command: inst.command,
                        cpu: 0,
                        memory: 0
                    };
                });
            promises.push(promise);
        } else {
            info[name] = {
                name,
                status: 'Stopped',
                pid: null,
                workingDir: inst.workingDir,
                command: inst.command,
                cpu: 0,
                memory: 0
            };
        }
    }

    await Promise.all(promises);
    res.json(info);
});

router.post('/instances', (req, res) => {
    const { name, workingDir, command } = req.body;
    if (!name || !workingDir || !command) return res.status(400).json({ error: "Missing fields" });
    if (instances[name]) return res.status(400).json({ error: "Instance already exists" });

    instances[name] = { name, workingDir, command, status: 'stopped', pid: null };
    saveInstances();
    res.json({ success: true });
});

router.post('/instances/:name/start', async (req, res) => {
    try {
        const pid = await startServer(req.params.name, io);
        res.json({ success: true, pid });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/instances/:name/stop', async (req, res) => {
    try {
        await stopServer(req.params.name);
        res.json({ success: true, message: 'Server stopped.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/instances/:name/restart', async (req, res) => {
    try {
        const pid = await restartServer(req.params.name, io);
        res.json({ success: true, pid, message: 'Server restarted.' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post('/instances/:name/terminate', (req, res) => {
    const name = req.params.name;
    const proc = processes[name];
    if (!proc) return res.status(404).json({ error: 'Instance not running' });

    proc.kill('SIGKILL');
    delete processes[name];
    instances[name].status = "stopped";
    instances[name].pid = null;
    delete instances[name];
    saveInstances();
    res.json({ success: true });
});

router.post('/instances/:name/command', (req, res) => {
    const name = req.params.name;
    const proc = processes[name];
    const { command } = req.body;
    if (!proc) return res.status(404).json({ error: 'Instance not running' });

    proc.stdin.write(command + '\n');
    res.json({ success: true });
});

router.get('/instances/:name/logs', (req, res) => {
    const name = req.params.name;
    res.send(instanceLogs[name] || '');
});

router.post('/set-instance', express.json(), (req, res) => {
    const instance = req.body.instance;
    if (!instance) return res.status(400).send('Missing instance name.');
    req.session.instance = instance;
    res.send('Instance set.');
});

// -------------------- FILE MANAGER --------------------

router.get('/files', async (req, res) => {
    try {
        const instanceName = req.query.instance;
        const pathQuery = req.query.path || '.';

        const instance = instances[instanceName];
        if (!instance) {
            return res.status(404).send("Instance not found");
        }

        const workingDir = instance.workingDir;
        const resolvedPath = path.resolve(workingDir, pathQuery);

        // Ensure workingDir exists
        await fs.mkdir(resolvedPath, { recursive: true });

        const items = await fs.readdir(resolvedPath, { withFileTypes: true });

        const result = items.map(item => ({
            name: item.name,
            type: item.isDirectory() ? 'directory' : 'file'
        }));

        res.json(result);
    } catch (err) {
        console.error('Error reading directory:', err);
        res.status(500).send(err.message);
    }
});



router.get('/files/download', (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.query.path;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        res.download(absPath, path.basename(absPath));
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});


router.post('/files/upload', (req, res) => {
    const instance = req.session.instance;
    if (!instance) return res.status(400).send('No instance selected.');
    const fileRoot = getFileRoot(instance);

    const form = new IncomingForm({ multiples: false });

    form.parse(req, async (err, fields, files) => {
        try {
            if (err) throw err;
            if (!files.file) return res.status(400).send('No file uploaded.');

            const uploadedFile = Array.isArray(files.file) ? files.file[0] : files.file;

            console.log('Single uploaded file:', uploadedFile);

            const relPath = Array.isArray(fields.path) ? fields.path[0] : (fields.path || '.');
            const uploadPath = safePath(fileRoot, relPath);
            await fs.ensureDir(uploadPath);

            const tempFilePath = uploadedFile.filepath || uploadedFile.path;
            if (!tempFilePath) {
                throw new Error('Uploaded file temporary path not found');
            }

            const filename = uploadedFile.originalFilename ?? uploadedFile.name ?? uploadedFile.newFilename ?? 'uploaded-file';
            const dest = path.join(uploadPath, filename);

            await fs.move(tempFilePath, dest, { overwrite: true });

            res.send('ok');
        } catch (err) {
            console.error(err);
            res.status(500).send(err.message);
        }
    });
});


router.post('/files/newfile', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.body.path;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        await fs.ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, '');
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

router.post('/files/newfolder', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.body.path;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        await fs.ensureDir(absPath);
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

router.post('/files/rename', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.body.path;
        const newName = req.body.newName;
        if (!relPath || !newName) return res.status(400).send('Missing path or newName.');

        const absOld = safePath(fileRoot, relPath);
        const absNew = path.join(path.dirname(absOld), newName);

        if (!absNew.startsWith(fileRoot)) {
            return res.status(403).send('Access denied.');
        }

        await fs.move(absOld, absNew, { overwrite: false });
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

router.post('/files/delete', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.body.path;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        await fs.remove(absPath);
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

router.get('/files/content', async (req, res) => {
    try {
        // Check instance in session OR query
        let instance = req.session.instance;

        if (!instance && req.query.instance) {
            instance = req.query.instance;
        }

        if (!instance) {
            return res.status(400).send('No instance selected.');
        }

        const fileRoot = getFileRoot(instance);

        const relPath = req.query.path;
        if (!relPath) {
            return res.status(400).send('Missing path.');
        }

        const absPath = safePath(fileRoot, relPath);
        const content = await fs.readFile(absPath, 'utf8');
        res.send(content);
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});

router.post('/files/content', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.body.path;
        const content = req.body.content;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        await fs.writeFile(absPath, content, 'utf8');

        res.send('OK');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});


router.post('/files/save', async (req, res) => {
    try {
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);
        const { path, content } = req.body;
        if (!path) return res.status(400).send('Missing path.');
        const absPath = safePath(fileRoot, path);
        await fs.writeFile(absPath, content, 'utf8');
        res.send('ok');
    } catch (err) {
        console.error(err);
        res.status(500).send(err.message);
    }
});


// --- SOCKET.IO SETUP ---
io.on('connection', (socket) => {
    //console.log(`Socket connected: ${socket.id}`);
    const session = socket.request.session;
    SOCKETS[socket.id] = socket;

    socket.on('subscribe', ({ instance }) => {
        if (!instances[instance]) {
            socket.emit('error', `Instance ${instance} does not exist.`);
            return;
        }
        socket.join(instance);
        session.instance = instance
        session.save()
        // console.log(`Socket ${socket.id} subscribed to ${instance}`);

        const logText = (instanceLogs[instance] || []).join('\n');
        socket.emit('instanceLogs', {
            instance,
            logs: logText
        });
    });

    socket.on('unsubscribe', ({ instance }) => {
        socket.leave(instance);
        // console.log(`Socket ${socket.id} unsubscribed from ${instance}`);
    });

    socket.on('getSystemInfo', () => {
        const cpus = os.cpus();
        const cpuLoad = cpus.reduce((sum, cpu) => sum + cpu.times.user, 0) / cpus.length;
        const totalMemMB = os.totalmem() / 1024 / 1024;
        const freeMemMB = os.freemem() / 1024 / 1024;
        const usedMemMB = totalMemMB - freeMemMB;

        socket.emit('systemInfo', {
            cpu: (cpuLoad / 1000),
            memoryUsedMB: usedMemMB,
            memoryTotalMB: totalMemMB
        });
    });

    socket.on('getInstancesList', () => {
        socket.emit('instancesList', instances);
    });

    socket.on('getInstancesStatus', () => {
        socket.emit('instancesStatus', instances);
    });

    socket.on("getInstanceSettings", ({ instance }) => {
        const inst = instances[instance];
        if (inst) {
            // Add the name explicitly
            const instWithName = {
                ...inst,
                name: instance
            };
            socket.emit("instanceSettings", { instance: instWithName });
        }
    });

    socket.on("updateInstanceSettings", (data) => {
        const { originalName, name, workingDir, command } = data;
        if (instances[originalName]) {
            instances[originalName].name = name;
            instances[originalName].workingDir = workingDir;
            instances[originalName].command = command;

            if (originalName !== name) {
                instances[name] = instances[originalName];
                delete instances[originalName];
            }

            socket.emit("actionResponse", {
                success: true,
                action: "updateInstanceSettings"
            });

            io.emit("instancesList", instances);
        } else {
            socket.emit("actionResponse", {
                success: false,
                action: "updateInstanceSettings",
                message: "Instance not found"
            });
        }
    });

    socket.on('getInstanceLogs', ({ instance }) => {
        socket.emit('instanceLogs', {
            instance,
            logs: logs[instance] || ''
        });
    });

    socket.on('instanceCommand', ({ instance, command }) => {
        const inst = instances[instance];
        if (!inst || !inst.pid) {
            socket.emit('actionResponse', {
                success: false,
                action: 'instanceCommand',
                message: `Instance ${instance} is not running.`
            });
            return;
        }

        // Find the process object from pm.processes
        const found = [...pm.processes.values()].find(p => p.pid === inst.pid);
        if (!found || !found.proc) {
            socket.emit('actionResponse', {
                success: false,
                action: 'instanceCommand',
                message: `Process info not found for ${instance}.`
            });
            return;
        }

        const proc = found.proc;

        if (!proc.stdin || proc.stdin.destroyed) {
            socket.emit('actionResponse', {
                success: false,
                action: 'instanceCommand',
                message: `Process stdin is not writable for ${instance}.`
            });
            return;
        }

        try {
            proc.stdin.write(command + "\n");
            socket.emit('actionResponse', {
                success: true,
                action: 'instanceCommand',
                message: `Sent command to ${instance}.`
            });
        } catch (err) {
            socket.emit('actionResponse', {
                success: false,
                action: 'instanceCommand',
                message: `Failed to write command: ${err.message}`
            });
        }
    });


    socket.on('instanceAction', ({ action, instance }) => {
        if (!instances[instance]) {
            socket.emit('actionResponse', {
                success: false,
                action,
                message: `Instance ${instance} does not exist`
            });
            return;
        }

        switch (action) {
            case 'start':
                startServer(instance, io)
                    .then(pid => {
                        socket.emit('actionResponse', {
                            success: true,
                            action,
                            pid
                        });
                        io.emit('instancesStatus', instances);
                    })
                    .catch(err => {
                        socket.emit('actionResponse', {
                            success: false,
                            action,
                            message: err.message
                        });
                    });
                break;
            case 'stop':
                stopServer(instance)
                    .then(() => {
                        instances[instance].status = "stopped";
                        instances[instance].pid = null;
                        saveInstances();
                        socket.emit('actionResponse', {
                            success: true,
                            action
                        });
                        io.emit('instancesStatus', instances);
                    })
                    .catch(err => {
                        socket.emit('actionResponse', {
                            success: false,
                            action,
                            message: err.message
                        });
                    });
                break;
            case 'restart':
                restartServer(instance, io)
                    .then(pid => {
                        socket.emit('actionResponse', {
                            success: true,
                            action,
                            pid
                        });
                        io.emit('instancesStatus', instances);
                    })
                    .catch(err => {
                        socket.emit('actionResponse', {
                            success: false,
                            action,
                            message: err.message
                        });
                    });
                break;
            case 'terminate':
                terminateInstance(instance, socket);
                break;
            default:
                socket.emit('actionResponse', {
                    success: false,
                    action,
                    message: `Unknown action: ${action}`
                });
                break;
        }
    });

    socket.on('disconnect', () => {
        console.log(`Socket disconnected: ${socket.id}`);
        delete SOCKETS[socket.id];
    });
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// Terminate instance helper
function terminateInstance(name, socket) {
    const proc = processes[name];
    if (proc) {
        proc.kill();
        delete processes[name];
    }
    if (instances[name]) {
        instances[name].status = "stopped";
        instances[name].pid = null;
        delete instances[name];
    }
    saveInstances();
    socket.emit('actionResponse', {
        success: true,
        action: "terminate"
    });

    io.emit('instancesList', instances);
    io.emit('instancesStatus', instances);
}
