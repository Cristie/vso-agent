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

import cfgm = require('./configuration');
import cm = require('./common');
import dm = require('./diagnostics');
import events = require('events');
import fm = require('feedback');
import fs = require('fs');
import ifm = require('./api/interfaces');
import lm = require('./logging');
import os = require("os");
import path = require('path');
import tm = require('tracing');
import um = require('./utilities');

export class Context extends events.EventEmitter {
	constructor(writers: cm.IDiagnosticWriter[]) {
		super();
		this.writers = writers;
		this.hasErrors = false;
	}

	public config: cm.IConfiguration;
	public workFolder: string;
	public hasErrors: boolean;
	private writers: cm.IDiagnosticWriter[];

	// TODO: parse line to direct appropriately
	public output(line: string) { 
		this.writers.forEach((writer) => {
			writer.write(line);
		});
	}

	public error(message: string) {
		this.hasErrors = true;
		this._write(cm.DiagnosticLevel.Error, 'Error', message);
	}

	public warning(message: string) {
		this._write(cm.DiagnosticLevel.Warning, 'Warning', message);
	}

	public info(message: string) {
		this._write(cm.DiagnosticLevel.Info, null, message);
	}

	public verbose(message: string) {
		this._write(cm.DiagnosticLevel.Verbose, null, message);
	}

	private _write(level: cm.DiagnosticLevel, tag: string, message: string) {
        if (typeof(message) !== 'string') {
            console.error('non-string write: ' + level, tag);
            console.error(JSON.stringify(message, null, 2));
            return;
        }

		var lines = message.split(os.EOL);

		for (var i in lines) {
			var line = lines[i].replace(/(\r\n|\n|\r)/gm, '');

			var prefix = tag ? '[' + tag + '] ' : '';
			var dateTime = new Date().toISOString() + ': ';

			this.emit('message', prefix + line);
			var logLine = prefix + dateTime + line + os.EOL;
			
			this.writers.forEach((writer) => {
				if (writer.level >= level) {
					if (level == cm.DiagnosticLevel.Error) {
						writer.writeError(logLine);
					}
					else {
						writer.write(logLine);	
					}
				}
			});			
		}
	}

	public heading(message: string) {
		this.writers.forEach((writer) => {

			if (writer.level >= cm.DiagnosticLevel.Status) {
				var delim = '----------------------------------------------------------------------' + os.EOL;
				this._write(cm.DiagnosticLevel.Info, null, delim + message + delim);
			}
		});	
	}

	public status(message: string) {
		this._write(cm.DiagnosticLevel.Status, null, message);
	}
	
	public section(message: string) {
		this.writers.forEach((writer) => {
			if (writer.level >= cm.DiagnosticLevel.Status) {
				this._write(cm.DiagnosticLevel.Info, null, ' ' + os.EOL + '+++++++' + message + ' ' + os.EOL);
			}
		});	
	}

	public end(): void {
		this.writers.forEach((writer) => {
			writer.end();
		});		
	}	
}

export class AgentContext extends Context implements cm.ITraceWriter {
	constructor(hostProcess: string, config: cm.IConfiguration) {
		this.config = config;
        this.workFolder = this.config.settings.workFolder;
        if (!this.workFolder.startsWith('/')) {
            this.workFolder = path.join(__dirname, this.config.settings.workFolder);
        }
        this.fileWriter = new dm.DiagnosticFileWriter(process.env[cm.envVerbose] ? cm.DiagnosticLevel.Verbose : cm.DiagnosticLevel.Info, 
					path.join(path.resolve(this.config.settings.workFolder), '_diag', hostProcess), 
					new Date().toISOString().replace(/:/gi, '_') + '_' + process.pid + '.log');

		var writers: cm.IDiagnosticWriter[] = [
					new dm.DiagnosticConsoleWriter(cm.DiagnosticLevel.Status), 
					this.fileWriter
					];

		super(writers);
	}

	private fileWriter: cm.IDiagnosticWriter;

	// ITraceWriter
	public trace(message: string) {
		this.fileWriter.write(message);
	}
}

export class ExecutionContext extends Context {
	constructor(jobInfo: cm.IJobInfo, 
				recordId: string, 
				feedback: cm.IFeedbackChannel,
				agentCtx: AgentContext) {

		this.jobInfo = jobInfo;
		this.variables = jobInfo.variables;
		this.recordId = recordId;
		this.agentCtx = agentCtx;
		this.feedback = feedback;
		this.config = agentCtx.config;

        this.workFolder = this.variables['sys.workFolder'];
        this.workingFolder = this.variables['sys.workingFolder'];

		var logFolder = path.join(this.workFolder, '_logs');

		var logData = <cm.ILogMetadata>{};
		logData.jobInfo = jobInfo;
		logData.recordId = recordId;

		var logger: lm.PagingLogger = new lm.PagingLogger(logFolder, logData);
		logger.level = process.env[cm.envVerbose] ? cm.DiagnosticLevel.Verbose : cm.DiagnosticLevel.Info;

        logger.on('pageComplete', function (info: cm.ILogPageInfo) {
        	feedback.queueLogPage(info);
         });

		this.util = new um.Utilities(this);

		super([logger]);
	}

	public agentCtx: AgentContext;
	public jobInfo: cm.IJobInfo;
	public variables: { [key: string]: string };
	public recordId: string;
	public workFolder: string;
	public workingFolder: string;
	public feedback: cm.IFeedbackChannel;
	public util: any;
}


//=================================================================================================
//
// JobContext 
//
//  - used by the infrastructure during the workers executions of a job
//  - has full access to the full job data including credentials etc...
//  - Job is renewed every minute
//
//  - Feedback
//    - PRINCIPLE: by lazy - only send/create if there's data to be written
//    - logs are sent up latent in pages (even fine if continues after job is complete)
//    - Live Web Console Feed lines are sent on independent time - sub second.  Later, sockets up
//    - Timeline status updated - sub second.  Independent queue.
//
//=================================================================================================

var LOCK_RENEWAL_MS = 60 * 1000;

export class JobContext extends ExecutionContext {
	constructor(job: ifm.JobRequestMessage,
				feedback: cm.IFeedbackChannel,
		        agentCtx: AgentContext) {

		this.job = job;

        var info: cm.IJobInfo = cm.jobInfoFromJob(job);

        this.jobInfo = info;
        this.feedback = feedback;

		super(info, job.timeline.id, feedback, agentCtx);
	}

	public job: ifm.JobRequestMessage;
	public jobInfo: cm.IJobInfo;
	public feedback: cm.IFeedbackChannel;

    //------------------------------------------------------------------------------------
    // Job/Task Status
    //------------------------------------------------------------------------------------
    public finishJob(result: ifm.TaskResult, callback: (err: any) => void): void {
    	this.setTaskResult(this.job.jobId, this.job.jobName, result);

        // drain the queues before exiting the worker
        this.feedback.drain((err: any) => {
        	if (err) {
        		console.log('Failed to drain queue');
        		result = ifm.TaskResult.Failed;
        	}

	        var jobRequest: ifm.TaskAgentJobRequest = <ifm.TaskAgentJobRequest>{};
	        jobRequest.requestId = this.job.requestId;
	        jobRequest.finishTime = new Date();
	        jobRequest.result = result;

	        this.feedback.updateJobRequest(this.config.poolId, 
	        	                           this.job.lockToken, 
	        	                           jobRequest, 
	        	                           callback);
        }); 	
    }

    public finishLogs(callback: (err: any) => void): void {
    	this.feedback.finish(callback);
    }

    public writeConsoleSection(message: string) {
    	this.feedback.queueConsoleSection(message);
    }

    public setJobInProgress(): void {
    	var jobId = this.job.jobId;

    	// job
    	this.feedback.setCurrentOperation(jobId, "Starting");
    	this.feedback.setName(jobId, this.job.jobName);
    	this.feedback.setStartTime(jobId, new Date());
    	this.feedback.setState(jobId, ifm.TimelineRecordState.InProgress);
    	this.feedback.setType(jobId, "Job");
    	this.feedback.setWorkerName(jobId, this.config.settings.agentName);
    }

    public registerPendingTask(id: string, name: string): void {
    	this.feedback.setCurrentOperation(id, "Initializing");
    	this.feedback.setParentId(id, this.job.jobId);
    	this.feedback.setName(id, name);
    	this.feedback.setState(id, ifm.TimelineRecordState.Pending);
    	this.feedback.setType(id, "Task");
    	this.feedback.setWorkerName(id, this.config.settings.agentName);    	
    }

    public setTaskStarted(id: string, name: string): void {

    	// set the job operation
		this.feedback.setCurrentOperation(this.job.jobId, 'Starting ' + name);

		// update the task
    	this.feedback.setCurrentOperation(id, "Starting " + name);
    	this.feedback.setStartTime(id, new Date());
    	this.feedback.setState(id, ifm.TimelineRecordState.InProgress);
    }

    public setTaskResult(id: string, name: string, result: ifm.TaskResult): void {

    	this.feedback.setCurrentOperation(id, "Completed " + name);
    	this.feedback.setState(id, ifm.TimelineRecordState.Completed);
    	this.feedback.setFinishTime(id, new Date());
    	this.feedback.setResult(id, result);
    }      
}

//=================================================================================================
//
// PluginContext 
//
//  - used by plugin authors 
//  - has full access to the full job data including credentials etc...
//
//=================================================================================================

export class PluginContext extends ExecutionContext {
	constructor(job: ifm.JobRequestMessage, 
				recordId: string, 
				feedback: cm.IFeedbackChannel,
				agentCtx: AgentContext) {

		this.job = job;
		var jobInfo: cm.IJobInfo = cm.jobInfoFromJob(job);

		super(jobInfo, recordId, feedback, agentCtx);
	}

	public job: ifm.JobRequestMessage;
	private agentApi: ifm.IAgentApi;
	private taskApi: ifm.ITaskApi;
}

//=================================================================================================
//
// TaskContext 
//
//  - pass to the task - available to custom task authors
//  - DOES NOT have access to the full job data including credentials etc...
//  - provided access to a set of task util libraries (ctx.util)
//
//=================================================================================================

export class TaskContext extends ExecutionContext {
	constructor(jobInfo: cm.IJobInfo, 
				recordId: string, 
				feedback: cm.IFeedbackChannel,
				agentCtx: AgentContext) {

		super(jobInfo, recordId, feedback, agentCtx);
	}

	public inputs: ifm.TaskInputs;		
}