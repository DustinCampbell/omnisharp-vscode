/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AbstractSupport from './abstractProvider';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';
import {toRange} from '../omnisharp/typeConvertion';
import {DocumentSymbolProvider, SymbolInformation, SymbolKind, TextDocument, CancellationToken} from 'vscode';

export default class OmnisharpDocumentSymbolProvider extends AbstractSupport implements DocumentSymbolProvider {

    public async provideDocumentSymbols(document: TextDocument, token: CancellationToken): Promise<SymbolInformation[]> {

        return serverUtils.currentFileMembersAsTree(this._server, { FileName: document.fileName }, token).then(tree => {
            let ret: SymbolInformation[] = [];
            for (let node of tree.TopLevelTypeDefinitions) {
                toDocumentSymbol(ret, node);
            }
            return ret;
        });
    }
}


export function toDocumentSymbol(bucket: SymbolInformation[], node: protocol.Node, containerLabel?: string): void {

    let ret = new SymbolInformation(node.Location.Text, _kinds[node.Kind],
        toRange(node.Location),
        undefined, containerLabel);

    if (node.ChildNodes) {
        for (let child of node.ChildNodes) {
            toDocumentSymbol(bucket, child, ret.name);
        }
    }
    
    bucket.push(ret);
}

const _kinds: { [kind: string]: SymbolKind; } = Object.create(null);

// types
_kinds['ClassDeclaration'] = SymbolKind.Class;
_kinds['EnumDeclaration'] = SymbolKind.Enum;
_kinds['InterfaceDeclaration'] = SymbolKind.Interface;
_kinds['StructDeclaration'] = SymbolKind.Enum;

// variables
_kinds['VariableDeclaration'] = SymbolKind.Variable;

// members
_kinds['EnumMemberDeclaration'] = SymbolKind.Property;
_kinds['EventFieldDeclaration'] = SymbolKind.Event;
_kinds['FieldDeclaration'] = SymbolKind.Field;
_kinds['MethodDeclaration'] = SymbolKind.Method;
_kinds['PropertyDeclaration'] = SymbolKind.Property;

// other stuff
_kinds['NamespaceDeclaration'] = SymbolKind.Namespace;

