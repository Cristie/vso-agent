// 
// Copyright (c) Microsoft and contributors.  All rights reserved.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//   http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// 
// See the License for the specific language governing permissions and
// limitations under the License.
// 

/// <reference path="./definitions/node.d.ts"/>
import ifm = require('./api/interfaces');
import path = require('path');
var fs = require('fs');
import os = require('os');
import cm = require('./common');
var shell = require('shelljs');
import events = require('events');
var async = require('async');

var uuid = require('node-uuid');

// TODO: support elapsed time as well
var PAGE_SIZE = 25;

//
// Synchronous logger with paging for upload to server.  Worker and tasks are synchronous via a child process so no need for async
//
export class PagingLogger extends events.EventEmitter implements cm.IDiagnosticWriter {
	constructor(logFolder: string, metadata: cm.ILogMetadata) {
		super();

		this.metadata = metadata;
		this.pagesId = uuid.v1();
		var logName = new Date().toISOString() + '_' + process.pid + '.log';
		this.logPath = path.join(logFolder, logName);
		this.pageFolder = path.join(logFolder, 'pages');
		shell.mkdir('-p', this.pageFolder);
		shell.chmod(775, this.pageFolder);
	}

	public level: cm.DiagnosticLevel;

	private metadata: cm.ILogMetadata;
	private created: boolean;
	private pagesId: string;
	private logPath: string;
	private pageFolder: string;
	private pageFilePath: string;
	private stream: WritableStream = null;
	private pageCount: number = 0;
	private lineCount: number = 0;
	private _fd:any;

	public write(line: string): void {
		// lazy creation on write
		if (!this._fd) {
			this.create();
		}

		fs.writeSync(this._fd, line);

		// TODO: split lines - line count not completely accurate
		if (++this.lineCount >= PAGE_SIZE) {
			this.newPage();
			
		}
	}

	public writeError(line: string): void {
		this.write(line);
	}

	public end(): void {
		this.endPage();
	}

	//------------------------------------------------------------------
	// PRIVATE
	//------------------------------------------------------------------
	private create(): void {
		// write the log metadata file

		this.metadata.pagesId = this.pagesId;
		this.metadata.logPath = this.logPath;
		var data = JSON.stringify(this.metadata, null, 2);
		fs.writeFileSync(this.logPath, data);

		this.newPage();
		this.created = true;
	}

	private newPage() {
		this.endPage();
		this.pageFilePath = path.join(this.pageFolder, this.pagesId + '_' + ++this.pageCount + '.page');
		this._fd = fs.openSync(this.pageFilePath, 'a'); // append, create if not exist
		this.created = true;
		this.lineCount = 0;
	}

	private endPage() {
		if (this._fd) {
			fs.closeSync(this._fd);
			this.created = false;

			var info = <cm.ILogPageInfo>{};
			info.logInfo = this.metadata;
			info.pagePath = this.pageFilePath;
			info.pageNumber = this.pageCount;

			this.emit('pageComplete', info);
		}
	}
}