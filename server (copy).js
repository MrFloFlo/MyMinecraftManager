// server.js

const express = require('express');
const session = require('express-session');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const { IncomingForm } = require('formidable');
const os = require('os');
const path = require('path');
const pidusage = require('pidusage');
const http = require('http');
const { Server } = require('socket.io');

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
const logs = {};
const processes = {};

// Load instances on startup
if (fs.existsSync(INSTANCE_FILE)) {
    instances = JSON.parse(fs.readFileSync(INSTANCE_FILE, 'utf-8'));
}

// Helper to check if a pid is running
function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// Check PIDs at server start
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

// Periodic status check
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

function saveInstances() {
    fs.writeFileSync(INSTANCE_FILE, JSON.stringify(instances, null, 2), 'utf-8');
}

function getFileRoot(instance) {
    if (!instance) throw new Error("No instance selected.");
    if (!instances[instance]) throw new Error("Instance not found.");
    return path.resolve(instances[instance].workingDir);
}

function safePath(base, relPath) {
    const fullPath = path.resolve(path.join(base, relPath));
    if (!fullPath.startsWith(base)) throw new Error("Access denied: path escapes base directory");
    return fullPath;
}

async function startServer(name, io) {
    const instance = instances[name];
    if (!instance) throw new Error('Instance not found');
    if (processes[name]) throw new Error('Instance already running');

    const [command, ...args] = instance.command.split(' ');
    const proc = spawn(command, args, { cwd: instance.workingDir, shell: true });

    processes[name] = proc;
    logs[name] = '';

    proc.stdout.on('data', data => {
        const text = data.toString();
        logs[name] += text;
        io.to(name).emit('log', { text });
    });

    proc.stderr.on('data', data => {
        const text = data.toString();
        logs[name] += text;
        io.to(name).emit('log', { text });
    });

    proc.on('exit', code => {
        console.log(`${name} stopped with code ${code}`);
        delete processes[name];
        instances[name].status = "stopped";
        instances[name].pid = null;
        logs[name] += `[Process exited with code ${code}]\n`;
        io.to(name).emit('log', { text: `[Process exited with code ${code}]\n` });
        io.to(name).emit('statusUpdate', { instance: name, status: 'stopped' });
        saveInstances();
    });

    instances[name].pid = proc.pid;
    instances[name].status = "running";
    saveInstances();
    io.to(name).emit('statusUpdate', { instance: name, status: 'running' });
    return proc.pid;
}

function stopServer(name) {
    return new Promise((resolve, reject) => {
        const proc = processes[name];
        if (!proc) return reject(new Error('Instance not running'));

        proc.stdin.write('stop\n');
        proc.once('exit', (code) => {
            console.log(`${name} stopped with code ${code}`);
            resolve();
        });
    });
}

async function restartServer(name, io) {
    await stopServer(name);
    await new Promise(r => setTimeout(r, 3000));
    return await startServer(name, io);
}

// ------------------- REST ROUTES ----------------------

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
    delete logs[name];
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
    res.send(logs[name] || '');
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
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.query.path || '.';
        const dir = safePath(fileRoot, relPath);

        const items = await fs.readdir(dir, { withFileTypes: true });
        const result = [];

        for (const entry of items) {
            const fullPath = path.join(dir, entry.name);
            const stat = await fs.stat(fullPath);

            result.push({
                name: entry.name,
                type: entry.isDirectory() ? 'directory' : 'file',
                size: entry.isDirectory() ? null : stat.size
            });
        }
        res.json(result);
    } catch (err) {
        console.error(err);
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
        const instance = req.session.instance;
        if (!instance) return res.status(400).send('No instance selected.');
        const fileRoot = getFileRoot(instance);

        const relPath = req.query.path;
        if (!relPath) return res.status(400).send('Missing path.');

        const absPath = safePath(fileRoot, relPath);
        const content = await fs.readFile(absPath, 'utf8');
        res.send(content);
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
        console.log(`Socket ${socket.id} subscribed to ${instance}`);

        socket.emit('instanceLogs', {
            instance,
            logs: logs[instance] || ""
        });
    });

    socket.on('unsubscribe', ({ instance }) => {
        socket.leave(instance);
        console.log(`Socket ${socket.id} unsubscribed from ${instance}`);
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
        if (!processes[instance]) {
            socket.emit('error', `Instance ${instance} is not running`);
            return;
        }
        processes[instance].stdin.write(command + '\n');
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
    if (logs[name]) {
        delete logs[name];
    }
    saveInstances();
    socket.emit('actionResponse', {
        success: true,
        action: "terminate"
    });

    io.emit('instancesList', instances);
    io.emit('instancesStatus', instances);
}
