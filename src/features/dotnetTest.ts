/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Logger } from '../logger';
import { OmniSharpServer } from '../omnisharp/server';
import { toRange } from '../omnisharp/typeConvertion';
import { DebuggerEventsProtocol } from '../coreclr-debug/debuggerEventsProtocol';
import * as vscode from 'vscode';
import * as serverUtils from "../omnisharp/utils";
import * as protocol from '../omnisharp/protocol';
import * as utils from '../common';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export class TestRunner {
    private _server: OmniSharpServer;
    private _channel: vscode.OutputChannel;
    private _logger: Logger;

    constructor(server: OmniSharpServer) {
        this._server = server;
        this._channel = vscode.window.createOutputChannel(".NET Test");
        this._logger = new Logger(message => this._channel.append(message));
    }

    private _showChannel() {
        this._channel.show();
    }

    private _subscribeToTestMessages(): vscode.Disposable {
        return this._server.onTestMessage(e => {
            this._logger.appendLine(e.Message);
        });
    }

    private _saveDirtyFiles(): Promise<boolean> {
        return Promise.resolve(
            vscode.workspace.saveAll(/*includeUntitled*/ false));
    }

    private _runTest(fileName: string, testMethod: string, testFrameworkName: string): Promise<protocol.V2.DotNetTestResult[]> {
        const request: protocol.V2.RunTestRequest = {
            FileName: fileName,
            MethodName: testMethod,
            TestFrameworkName: testFrameworkName
        };

        return serverUtils.runTest(this._server, request)
            .then(response => response.Results);
    }

    private _reportResults(results: protocol.V2.DotNetTestResult[]): Promise<void> {
        const totalTests = results.length;

        let totalPassed = 0, totalFailed = 0, totalSkipped = 0;
        for (let result of results) {
            switch (result.Outcome) {
                case protocol.V2.TestOutcomes.Failed:
                    totalFailed += 1;
                    break;
                case protocol.V2.TestOutcomes.Passed:
                    totalPassed += 1;
                    break;
                case protocol.V2.TestOutcomes.Skipped:
                    totalSkipped += 1;
                    break;
            }
        }

        this._logger.appendLine();
        this._logger.appendLine(`Total tests: ${totalTests}. Passed: ${totalPassed}. Failed: ${totalFailed}. Skipped: ${totalSkipped}`);
        this._logger.appendLine();

        return Promise.resolve();
    }

    private _createLaunchConfiguration(program: string, args: string, cwd: string, debuggerEventsPipeName: string) {
        let debugOptions = vscode.workspace.getConfiguration('csharp').get('unitTestDebugingOptions');

        // Get the initial set of options from the workspace setting
        let result: any;
        if (typeof debugOptions === "object") {
            // clone the options object to avoid changing it
            result = JSON.parse(JSON.stringify(debugOptions));
        } else {
            result = {};
        }

        // Now fill in the rest of the options
        result.name = ".NET Test Launch";
        result.type = "coreclr";
        result.request = "launch";
        result.debuggerEventsPipeName = debuggerEventsPipeName;
        result.program = program;
        result.args = args;
        result.cwd = cwd;

        return result;
    }

    private _getLaunchConfigurationForVSTest(fileName: string, testMethod: string, testFrameworkName: string, debugEventListener: DebugEventListener): Promise<any> {
        // Listen for test messages while getting start info.
        const listener = this._subscribeToTestMessages();

        const request: protocol.V2.DebugTestGetStartInfoRequest = {
            FileName: fileName,
            MethodName: testMethod,
            TestFrameworkName: testFrameworkName
        };

        return serverUtils.debugTestGetStartInfo(this._server, request)
            .then(response => {
                listener.dispose();
                return this._createLaunchConfiguration(response.FileName, response.Arguments, response.WorkingDirectory, debugEventListener.pipePath());
            });
    }

    private _getLaunchConfigurationForLegacy(fileName: string, testMethod: string, testFrameworkName: string): Promise<any> {
        // Listen for test messages while getting start info.
        const listener = this._subscribeToTestMessages();

        const request: protocol.V2.GetTestStartInfoRequest = {
            FileName: fileName,
            MethodName: testMethod,
            TestFrameworkName: testFrameworkName
        };

        return serverUtils.getTestStartInfo(this._server, request)
            .then(response => {
                listener.dispose();
                return this._createLaunchConfiguration(response.Executable, response.Argument, response.WorkingDirectory, /* debuggerEventsPipeName */ null);
            });
    }

    private _getLaunchConfiguration(debugType: string, fileName: string, testMethod: string, testFrameworkName: string, debugEventListener: DebugEventListener): Promise<any> {
        switch (debugType) {
            case 'legacy':
                return this._getLaunchConfigurationForLegacy(fileName, testMethod, testFrameworkName);
            case 'vstest':
                return this._getLaunchConfigurationForVSTest(fileName, testMethod, testFrameworkName, debugEventListener);

            default:
                throw new Error(`Unexpected debug type: ${debugType}`);
        }
    }

    public runTest(testMethod: string, fileName: string, testFrameworkName: string) {
        this._showChannel();
        this._logger.appendLine(`Running test ${testMethod}...`);
        this._logger.appendLine();

        const listener = this._subscribeToTestMessages();

        this._saveDirtyFiles()
            .then(_ => this._runTest(fileName, testMethod, testFrameworkName))
            .then(results => this._reportResults(results))
            .then(() => listener.dispose())
            .catch(reason => {
                listener.dispose();
                vscode.window.showErrorMessage(`Failed to run test because ${reason}.`);
            });
    }

    public debugTest(testMethod: string, fileName: string, testFrameworkName: string) {
        this._showChannel();
        this._logger.appendLine(`Debugging method '${testMethod}'...`);
        this._logger.appendLine();

        let debugType: string;
        let debugEventListener: DebugEventListener = null;

        return this._saveDirtyFiles()
            .then(_ => serverUtils.requestProjectInformation(this._server, { FileName: fileName }))
            .then(projectInfo => {
                if (projectInfo.DotNetProject) {
                    debugType = 'legacy';
                    return Promise.resolve();
                }
                else if (projectInfo.MsBuildProject) {
                    debugType = 'vstest';
                    debugEventListener = new DebugEventListener(fileName, this._server, this._logger);
                    return debugEventListener.start();
                }
                else {
                    throw new Error('Expected project.json or .csproj project.');
                }
            })
            .then(() => this._getLaunchConfiguration(debugType, fileName, testMethod, testFrameworkName, debugEventListener))
            .then(config => vscode.commands.executeCommand('vscode.startDebug', config))
            .catch(reason => {
                vscode.window.showErrorMessage(`Failed to start debugger: ${reason}`);
                if (debugEventListener != null) {
                    debugEventListener.close();
                }
            });
    }
}

export function registerDotNetTestRunCommand(testRunner: TestRunner): vscode.Disposable {
    return vscode.commands.registerCommand(
        'dotnet.test.run',
        (testMethod, fileName, testFrameworkName) => testRunner.runTest(testMethod, fileName, testFrameworkName));
}

export function registerDotNetTestDebugCommand(testRunner: TestRunner): vscode.Disposable {
    return vscode.commands.registerCommand(
        'dotnet.test.debug',
        (testMethod, fileName, testFrameworkName) => testRunner.debugTest(testMethod, fileName, testFrameworkName));
}

export function updateCodeLensForTest(bucket: vscode.CodeLens[], fileName: string, node: protocol.Node, isDebugEnable: boolean) {
    // backward compatible check: Features property doesn't present on older version OmniSharp
    if (node.Features === undefined) {
        return;
    }

    let testFeature = node.Features.find(value => (value.Name == 'XunitTestMethod' || value.Name == 'NUnitTestMethod' || value.Name == 'MSTestMethod'));
    if (testFeature) {
        // this test method has a test feature
        let testFrameworkName = 'xunit';
        if (testFeature.Name == 'NunitTestMethod') {
            testFrameworkName = 'nunit';
        }
        else if (testFeature.Name == 'MSTestMethod') {
            testFrameworkName = 'mstest';
        }

        bucket.push(new vscode.CodeLens(
            toRange(node.Location),
            { title: "run test", command: 'dotnet.test.run', arguments: [testFeature.Data, fileName, testFrameworkName] }));

        if (isDebugEnable) {
            bucket.push(new vscode.CodeLens(
                toRange(node.Location),
                { title: "debug test", command: 'dotnet.test.debug', arguments: [testFeature.Data, fileName, testFrameworkName] }));
        }
    }
}

class DebugEventListener {
    static s_activeInstance: DebugEventListener = null;

    private _fileName: string;
    private _server: OmniSharpServer;
    private _logger: Logger;
    private _pipePath: string;

    private _serverSocket: net.Server;
    private _isClosed: boolean = false;

    constructor(fileName: string, server: OmniSharpServer, logger: Logger) {
        this._fileName = fileName;
        this._server = server;
        this._logger = logger;

        // NOTE: The max pipe name on OSX is fairly small, so this name shouldn't bee too long.
        const pipeSuffix = 'TestDebugEvents-' + process.pid;
        if (os.platform() === 'win32') {
            this._pipePath = "\\\\.\\pipe\\Microsoft.VSCode.CSharpExt." + pipeSuffix;
        } else {
            this._pipePath = path.join(utils.getExtensionPath(), "." + pipeSuffix);
        }
    }

    public start(): Promise<void> {

        // We use our process id as part of the pipe name, so if we still somehow have an old instance running, close it.
        if (DebugEventListener.s_activeInstance !== null) {
            DebugEventListener.s_activeInstance.close();
        }

        DebugEventListener.s_activeInstance = this;

        this._serverSocket = net.createServer((socket: net.Socket) => {
            socket.on('data', (buffer: Buffer) => {
                let event: DebuggerEventsProtocol.DebuggerEvent;
                try {
                    event = DebuggerEventsProtocol.decodePacket(buffer);
                }
                catch (e) {
                    this._logger.appendLine('Warning: Invalid event received from debugger');
                    return;
                }

                switch (event.eventType) {
                    case DebuggerEventsProtocol.EventType.ProcessLaunched:
                        let processLaunchedEvent = <DebuggerEventsProtocol.ProcessLaunchedEvent>(event);
                        this._logger.appendLine(`Started debugging process #${processLaunchedEvent.targetProcessId}.`);
                        this.onProcessLaunched(processLaunchedEvent.targetProcessId);
                        break;

                    case DebuggerEventsProtocol.EventType.DebuggingStopped:
                        this._logger.appendLine('Debugging complete.');
                        this._logger.appendLine();
                        this.onDebuggingStopped();
                        break;
                }
            });

            socket.on('end', () => {
                this.onDebuggingStopped();
            });
        });

        return this.removeSocketFileIfExists().then(() => {
            return new Promise<void>((resolve, reject) => {
                let isStarted: boolean = false;
                this._serverSocket.on('error', (err: Error) => {
                    if (!isStarted) {
                        reject(err.message);
                    } else {
                        this._logger.appendLine(`Warning: Communications error on debugger event channel. ${err.message}`);
                    }
                });

                this._serverSocket.listen(this._pipePath, () => {
                    isStarted = true;
                    resolve();
                });
            });
        });
    }

    public pipePath(): string {
        return this._pipePath;
    }

    public close() {
        if (this === DebugEventListener.s_activeInstance) {
            DebugEventListener.s_activeInstance = null;
        }

        if (this._isClosed) {
            return;
        }

        this._isClosed = true;

        if (this._serverSocket !== null) {
            this._serverSocket.close();
        }
    }

    private onProcessLaunched(targetProcessId: number): void {
        let request: protocol.V2.DebugTestLaunchRequest = {
            FileName: this._fileName,
            TargetProcessId: targetProcessId
        };

        const disposable = this._server.onTestMessage(e => {
            this._logger.appendLine(e.Message);
        });

        serverUtils.debugTestLaunch(this._server, request)
            .then(_ => {
                disposable.dispose();
            });
    }

    private onDebuggingStopped(): void {
        if (this._isClosed) {
            return;
        }

        let request: protocol.V2.DebugTestStopRequest = {
            FileName: this._fileName
        };

        serverUtils.debugTestStop(this._server, request);

        this.close();
    }

    private removeSocketFileIfExists(): Promise<void> {
        if (os.platform() === 'win32') {
            // Win32 doesn't use the file system for pipe names
            return Promise.resolve();
        }
        else {
            return utils.deleteIfExists(this._pipePath);
        }
    }
}