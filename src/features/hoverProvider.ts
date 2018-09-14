/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import AbstractSupport from './abstractProvider';
import * as protocol from '../omnisharp/protocol';
import * as serverUtils from '../omnisharp/utils';
import { createRequest } from '../omnisharp/typeConvertion';
import { HoverProvider, Hover, TextDocument, CancellationToken, Position } from 'vscode';
// import { GetDocumentationString } from './documentation';

import QuickInfo = protocol.V2.QuickInfo;

export default class OmniSharpHoverProvider extends AbstractSupport implements HoverProvider {

    public async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover> {

        const request = createRequest<QuickInfo.QuickInfoRequest>(document, position);
        const response = await serverUtils.quickInfo(this._server, request, token);

        let documentation = [];

        function adjustText(text: string): string {
            return text.trim().replace("\r\n", "\n\n");
        }    

        for (let section of response.Sections) {
            if (section.Kind === 'Description' ||
                section.Kind === 'TypeParameters' ||
                section.Kind === 'AnonymousTypes') {
                documentation.push({ language: 'csharp', value: adjustText(section.Text) });
            }
            else {
                documentation.push(adjustText(section.Text));
            }
        }

        return new Hover(documentation);
        // let req = createRequest<protocol.TypeLookupRequest>(document, position);
        // req.IncludeDocumentation = true;

        // let response = await serverUtils.typeLookup(this._server, req, token);
        // if (response && response.Type) {
        //     let documentation = GetDocumentationString(response.StructuredDocumentation);
        //     let contents = [documentation, { language: 'csharp', value: response.Type }];
        //     return new Hover(contents);
        // }
    }
}