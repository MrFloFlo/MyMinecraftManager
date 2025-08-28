const { spawn } = require("child_process");
const pidusage = require("pidusage");
const fs = require("fs");
const path = require("path");

class ProcessManager {
    constructor() {
        this.processes = new Map();
        this.nextId = 1;

        this.disabledCommands = this.loadDisabledCommands();

        this.logDir = path.join(__dirname, "logs");
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    loadDisabledCommands() {
        const filePath = path.join(__dirname, "disabled_commands.json");
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath, "utf-8");
                return JSON.parse(data);
            } catch (e) {
                console.error("Error reading disabled_commands.json:", e);
            }
        }
        return [];
    }

    isCommandWithArgsDisabled(command, args) {
        const cmdLower = command.toLowerCase();
        const argsLower = args.map(a => a.toLowerCase());

        return this.disabledCommands.some(entry => {
            if (entry.command.toLowerCase() !== cmdLower) return false;

            if (!entry.args || entry.args.length === 0) return true;

            if (entry.args.length > argsLower.length) return false;

            for (let i = 0; i < entry.args.length; i++) {
                if (entry.args[i].toLowerCase() !== argsLower[i]) {
                    return false;
                }
            }
            return true;
        });
    }

    appendError(command, errorMsg, procInfo) {
        const timestamp = new Date().toISOString();
        const fullMsg = `[${timestamp}] ${errorMsg}\n`;

        if (procInfo) {
            procInfo.errors.push(errorMsg);
        }

        const safeCommand = command.replace(/[<>:"\/\\|?*\x00-\x1F]/g, "_");
        const logPath = path.join(this.logDir, `${safeCommand}_log.txt`);
        fs.appendFile(logPath, fullMsg, err => {
            if (err) {
                console.error(`Failed to write to log file ${logPath}:`, err);
            }
        });
    }

    spawnProcess(command, args = [], options = {}) {
        if (this.isCommandWithArgsDisabled(command, args)) {
            console.log(command, args)
            const id = this.nextId++;
            const errorMsg = `Command "${command}" with args [${args.join(", ")}] is disabled and cannot be run.`;
            this.processes.set(id, {
                id,
                command,
                args,
                pid: null,
                cpu: 0,
                memory: 0,
                errors: [errorMsg],
            });
            this.appendError(command, errorMsg, this.processes.get(id));
            return id;
        }

        try {
            const proc = spawn(command, args, {
                cwd: options.cwd || undefined,
                detached: true,
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe'] // adjust if you want stdout/stderr
            });

            const id = this.nextId++;
            this.processes.set(id, {
                id,
                command,
                args,
                proc,
                pid: proc.pid,
                cpu: 0,
                memory: 0,
                errors: []
            });

            return id;
        } catch (err) {
            const id = this.nextId++;
            this.processes.set(id, {
                id,
                command,
                args,
                pid: null,
                cpu: 0,
                memory: 0,
                errors: [err.message]
            });
            this.appendError(command, err.message, this.processes.get(id));
            return id;
        }
    }


    killProcess(processId) {
        const info = this.processes.get(processId);
        if (info && info.pid) {
            try {
                process.kill(-info.pid, "SIGTERM"); // Negative kills entire process group
            } catch (e) {
                const msg = `Error killing process ${info.pid}: ${e.message}`;
                this.appendError(info.command, msg, info);
            }
        } else if (info && !info.pid) {
            const msg = "Cannot kill process: process was never started or already exited.";
            this.appendError(info.command, msg, info);
        }
    }

    listProcesses() {
        return Array.from(this.processes.values()).map(p => ({
            id: p.id,
            pid: p.pid,
            command: p.command,
            args: p.args,
            cpu: p.cpu,
            memory: p.memory,
            hasErrors: p.errors.length > 0,
            stdoutLog: p.stdoutPath,
            stderrLog: p.stderrPath
        }));
    }

    async updateStats() {
        const promises = [];

        for (const info of this.processes.values()) {
            if (info.pid) {
                const promise = pidusage(info.pid)
                    .then(stat => {
                        info.cpu = stat.cpu;
                        info.memory = stat.memory;
                    })
                    .catch(err => {
                        const msg = `Error fetching stats for PID ${info.pid}: ${err.message}`;
                        this.appendError(info.command, msg, info);
                    });
                promises.push(promise);
            }
        }

        await Promise.all(promises);
    }

    checkErrors(processId) {
        const info = this.processes.get(processId);
        if (!info) return [`Process ID ${processId} not found.`];
        return info.errors;
    }
}

module.exports = ProcessManager;
