/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'async-file';
import * as vscode from 'vscode';

import poll from './poll';
import { should } from 'chai';
import { activateCSharpExtension } from './integrationHelpers';
import testAssetWorkspace from './testAssets/testAssetWorkspace';

const chai = require('chai');
chai.use(require('chai-arrays'));
chai.use(require('chai-fs'));

suite(`Tasks generation: ${testAssetWorkspace.description}`, function () {
    suiteSetup(async function () {
        should();
        await activateCSharpExtension();

        await vscode.commands.executeCommand("dotnet.generateAssets");

        await poll(async () => await fs.exists(testAssetWorkspace.launchJsonPath), 10000, 100);
    });

    suiteTeardown(async () => {
        await testAssetWorkspace.cleanupWorkspace();
    });

    test("Starting .NET Core Launch (console) from the workspace root should create an Active Debug Session", async () => {
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], ".NET Core Launch (console)");

        let debugSessionTerminated = new Promise(resolve => {
            vscode.debug.onDidTerminateDebugSession((e) => resolve());
        });

        vscode.debug.activeDebugSession.type.should.equal("coreclr");

        await debugSessionTerminated;
    });
});