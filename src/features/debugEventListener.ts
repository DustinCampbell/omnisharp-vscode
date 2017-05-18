/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Logger } from '../logger';
import * as debuggerEvents from '../coreclr-debug/debuggerEventsProtocol';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as utils from '../common';
import * as vscode from 'vscode';

export class DebugEventListener {
    static s_activeInstance: DebugEventListener = null;

    private _eventBus: NodeJS.EventEmitter;

    private _logger: Logger;
    private _pipePath: string;

    private _serverSocket: net.Server;
    private _isClosed: boolean = false;

    constructor(logger: Logger) {
        this._logger = logger;
        this._eventBus = new NodeJS.EventEmitter();

        // NOTE: The max pipe name on OSX is fairly small, so this name shouldn't bee too long.
        const pipeSuffix = 'TestDebugEvents-' + process.pid;
        if (os.platform() === 'win32') {
            this._pipePath = "\\\\.\\pipe\\Microsoft.VSCode.CSharpExt." + pipeSuffix;
        } else {
            this._pipePath = path.join(utils.getExtensionPath(), "." + pipeSuffix);
        }
    }

    private _addListener(event: string, listener: (e: any) => any): vscode.Disposable {
        this._eventBus.addListener(event, listener);
        return new vscode.Disposable(() => this._eventBus.removeListener(event, listener));
    }

    private _fireEvent(event: string, ...args: any[]): void {
        this._eventBus.emit(event, args);
    }

    public onProcessLaunched(listener: (processId: number) => any) {
        return this._addListener(debuggerEvents.EventType.ProcessLaunched, listener);
    }

    public onDebuggingStopped(listener: () => any) {
        return this._addListener(debuggerEvents.EventType.DebuggingStopped, listener);
    }

    private _onDebuggingStopped(): void {
        if (this._isClosed) {
            return;
        }

        this._fireEvent(debuggerEvents.EventType.DebuggingStopped);

        this.close();
    }

    private _configureSocket(socket: net.Socket) {
        socket.on('data', (buffer: Buffer) => {
            let event: debuggerEvents.DebuggerEvent;
            try {
                event = debuggerEvents.decodePacket(buffer);
            }
            catch (e) {
                this._logger.appendLine('Warning: Invalid event received from debugger');
                return;
            }

            switch (event.eventType) {
                case debuggerEvents.EventType.ProcessLaunched:
                    let processLaunchedEvent = <debuggerEvents.ProcessLaunchedEvent>(event);
                    this._logger.appendLine(`Started debugging process #${processLaunchedEvent.targetProcessId}.`);
                    this._fireEvent(debuggerEvents.EventType.ProcessLaunched, processLaunchedEvent.targetProcessId);
                    break;

                case debuggerEvents.EventType.DebuggingStopped:
                    this._logger.appendLine('Debugging complete.');
                    this._logger.appendLine();
                    this._onDebuggingStopped();
                    break;
            }
        });

        socket.on('end', () => {
            this._onDebuggingStopped();
        });
    }

    private _startListening(server: net.Server): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let isStarted = false;

            server.on('error', (err: Error) => {
                if (!isStarted) {
                    reject(err.message);
                }
                else {
                    this._logger.appendLine(`Warning: Communications error on debugger event channel. ${err.message}`);
                }
            });

            server.listen(this._pipePath, () => {
                isStarted = true;
                resolve();
            });
        });
    }

    private _removeSocketFileIfExists(): Promise<void> {
        if (os.platform() === 'win32') {
            // Win32 doesn't use the file system for pipe names
            return Promise.resolve();
        }
        else {
            return utils.deleteIfExists(this._pipePath);
        }
    }

    private _clearActiveInstance(): Promise<void> {
        // We use our process id as part of the pipe name, so if we still somehow have an old instance running, close it.
        if (DebugEventListener.s_activeInstance !== null) {
            return DebugEventListener.s_activeInstance.close();
        }

        return Promise.resolve();
    }

    public pipePath(): string {
        return this._pipePath;
    }

    public start(): Promise<void> {
        return this._clearActiveInstance()
            .then(() => {
                DebugEventListener.s_activeInstance = this;
                this._serverSocket = net.createServer(this._configureSocket);
            })
            .then(this._removeSocketFileIfExists)
            .then(() => this._startListening(this._serverSocket));
    }

    public close(): Promise<void> {
        if (this === DebugEventListener.s_activeInstance) {
            DebugEventListener.s_activeInstance = null;
        }

        if (this._isClosed) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            if (this._serverSocket !== null) {
                this._serverSocket.close(err => {
                    if (!err) {
                        reject(err);
                    }
                    else {
                        resolve();
                    }

                    this._isClosed = true;
                });
            }
        });
    }
}