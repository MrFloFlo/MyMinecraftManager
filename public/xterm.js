import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

let term;
let fitAddon;

document.addEventListener("DOMContentLoaded", () => {
    fitAddon = new FitAddon();
    term = new Terminal({
        theme: {
            background: '#000000',
            foreground: '#00FF00',
        },
        fontFamily: 'monospace',
        fontSize: 14,
        cursorBlink: true,
        rows: 24,
    });

    term.loadAddon(fitAddon);
    term.open(document.getElementById("console-container"));
    fitAddon.fit();

    term.writeln("Welcome to Minecraft Manager Terminal!");

    socketInstance.on("log", (data) => {
        term.write(data.text);
    });

    term.onData(input => {
        socketInstance.emit("instanceCommand", {
            instance: selectedInstance,
            command: input.trim()
        });
    });
});

window.addEventListener('resize', () => {
    fitAddon.fit();
});
