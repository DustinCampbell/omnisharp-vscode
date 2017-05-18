/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DebugEventListener } from './debugEventListener';
import { Logger } from '../logger';
import { OmniSharpServer } from '../omnisharp/server';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from "../omnisharp/utils";
import * as vscode from 'vscode';

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