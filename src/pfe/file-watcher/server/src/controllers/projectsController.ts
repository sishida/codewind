/*******************************************************************************
 * Copyright (c) 2019 IBM Corporation and others.
 * All rights reserved. This program and the accompanying materials
 * are made available under the terms of the Eclipse Public License v2.0
 * which accompanies this distribution, and is available at
 * http://www.eclipse.org/legal/epl-v20.html
 *
 * Contributors:
 *     IBM Corporation - initial API and implementation
 *******************************************************************************/
"use strict";
import { promisify } from "util";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

// local imports
import { actionMap } from "../projects/actions";
import * as projectSpecifications from "../projects/projectSpecifications";
import { Operation } from "../projects/operation";
import * as localeTrans from "../utils/locale";
import { AppLog, BuildLog, ProjectInfo, ProjectMetadata, ProjectCapabilities, UpdateProjectInfoPair, InotifyArgs, ProjectSettingsEvent } from "../projects/Project";
import * as io from "../utils/socket";
import * as utils from "../utils/utils";
import * as constants from "../projects/constants";
import * as projectUtil from "../projects/projectUtil";
import * as logHelper from "../projects/logHelper";
import * as logger from "../utils/logger";
import * as statusController from "./projectStatusController";
import * as projectExtensions from "../extensions/projectExtensions";
import * as processManager from "../utils/processManager";
import { Validator } from "../projects/Validator";
import { Environment } from "../utils/environment";


interface ProjectInfoCache {
    [file: string]: string;
}

interface BuildQueueType {
    operation: Operation;
    handler: any;
}

const readFileAsync = promisify(fs.readFile);
const mkDirAsync = promisify(fs.mkdir);
const fileStatAsync = promisify(fs.stat);

const projectInfoCache = {} as ProjectInfoCache;

const projectList = new Map();

let buildQueue: Array<BuildQueueType> = [];
let runningBuilds: Array<BuildQueueType> = [];
const MAX_BUILDS = parseInt(process.env.MC_MAX_BUILDS) || 3;
const BUILD_KEY = "projectStatusController.buildRank";

// timeout to ping build projects
setInterval(checkBuildQueue, 5000);

const availabilityTimeout = 5000;

/**
 * @see [[Filewatcher.getProjectTypes]]
 */
export async function getProjectTypes(location: string): Promise<IGetProjectTypesSuccess | IGetProjectTypesFailure> {

    let types: string[] = [];

    // If no project location is specified then return all known types
    if (!location) {
        types = projectExtensions.getAllProjectTypes();
        return { "statusCode": 200, "types": types};
    }

    try {
        types = await projectExtensions.determineProjectType(location);
    } catch (err) {
        let returnCode: 404 | 500;
        if (err.name == "FILE_NOT_EXIST")
            returnCode = 404;
        else
            returnCode = 500;

        const msg = "The project type cannot be determined for project " + location + "\n " + err;
        logger.logFileWatcherError(msg);
        return { "statusCode": returnCode, "error": { "msg": msg }};
    }
    return { "statusCode": 200, "types": types};
}

/**
 * @see [[Filewatcher.getProjectCapabilities]]
 */
export async function getProjectCapabilities(projectID: string): Promise<IGetProjectCapabilitiesSuccess | IGetProjectCapabilitiesFailure> {

    if (!projectID) {
        return { "statusCode": 400, "error": { "msg": "Bad request - no project ID specified"}};
    }

    try {
        const projectInfo = await projectUtil.getProjectInfo(projectID);
        if (!projectInfo) {
            throw new Error("Could not retrieve project info for project id: " + projectID);
        }
        const projectHandler = await projectExtensions.getProjectHandler(projectInfo);
        if (!projectHandler) {
            throw new Error("Could not get project handler for project id: " + projectID + " and project type: " + projectInfo.projectType);
        }

        const capabilities = projectExtensions.getProjectCapabilities(projectHandler);
        return { "statusCode": 200, "capabilities": capabilities};
    } catch (err) {
        const msg = "An error occurred while executing the action getProjectCapabilities:\n " + err.message;
        logger.logProjectError(msg, projectID);
        return { "statusCode": 404, "error": { "msg": msg }};
    }
}

/**
 * @see [[Filewatcher.createProject]]
 */
export async function createProject(req: ICreateProjectParams): Promise<ICreateProjectSuccess | ICreateProjectFailure> {
    // request data for project creation
    const projectID = req.projectID;
    const projectType = req.projectType;
    const projectLocation = req.location;
    let settings: IProjectSettings = undefined;
    const settingsFilePath = path.join(projectLocation, ".cw-settings");
    if (await utils.asyncFileExists(settingsFilePath)) {
        const data = await readFileAsync(settingsFilePath, "utf8");
        settings = JSON.parse(data);
    }

    if (settings) {
        logger.logProjectInfo("Project Settings: " + JSON.stringify(settings), projectID);

        if (settings.internalPort) {
            settings.internalPort = settings.internalPort.toString();
        }

        if (settings.internalDebugPort) {
            settings.internalDebugPort = settings.internalDebugPort.toString();
        }
    }

    // if neither of project id, type or location is not specified, throw a 400 error
    if (!projectID || !projectType || !projectLocation) {
        return { "statusCode": 400, "error": { "msg": "projectID, projectType and location are required parameters" }};
    }

    const projectName = projectLocation.split("/").pop();

    // create log storing directory for the project
    logger.logFileWatcherInfo("Creating project logs directory");
    const dirName = await logHelper.getLogDir(projectID, projectName);
    await logHelper.createLogDir(dirName, constants.projectConstants.projectsLogDir);

    let projInfo: ProjectInfo;
    try {
        // check project information for the requested project id. if the project exists, and the metadata of the project
        // is differs from the requested object, throw a 400 error and do not trigger a build.
        projInfo = await projectUtil.getProjectInfo(projectID);
        if (projInfo) {
            if (projInfo.projectType != projectType || projInfo.location != projectLocation) {
                logger.logProjectInfo("Information for project " + projectID + ": " + JSON.stringify(projInfo), projectID, projectName);
                return {  "statusCode": 400, "error": {"msg": "Project with ID " + projectID + " exists" }};
            }
            logger.logProjectInfo("Re-creating project " + projectLocation, projectID, projectName);
            // Kill all existing project process before recreating the project.
            processManager.killRunningProcesses(projectID, projectName);
        }
    } catch (err) {
        logger.logProjectError(err.message, projectID, projectName);
    }

    // didn't find project info, so we're creating a new project
    if (!projInfo) {
        logger.logProjectInfo("Creating project " + projectLocation, projectID, projectName);

        projInfo = {
            projectType: projectType,
            location: projectLocation
        } as ProjectInfo;

        if (req.extension)
            projInfo.extensionID = req.extension.name;
    }

    if (! await utils.asyncFileExists(projectLocation)) {
        const msg = "The location does not exist: " + projectLocation;
        logger.logProjectError(msg, projectID, projectName);
        return { "statusCode": 404, "error": {"msg": msg }};
    }

    const selectedProjectHandler = await projectExtensions.getProjectHandler(projInfo);

    if (!selectedProjectHandler || selectedProjectHandler.supportedType !== projectType) {
        const msg = "The project type " + projectType + " is not supported";
        logger.logProjectError(msg, projectID, projectName);
        return {  "statusCode": 404, "error": {"msg": msg }};
    }

    const imageId = projectID + "-" + projectType + "-" + crypto.createHash("sha1", { encoding: "utf8" }).update(projectLocation).digest("hex");
    logger.logProjectInfo("The generated image ID is: " + imageId, projectID, projectName);
    logger.logProjectInfo("Project data directory: " + constants.projectConstants.projectsDataDir, projectID, projectName);

    const projectInfo: ProjectInfo = {
        projectID: projectID,
        projectType: projectType,
        location: projectLocation,
        autoBuildEnabled: true,
        startMode: "run",
        appPorts: [],
        extensionID: projInfo.extensionID
    };
    const startMode = req.startMode;
    if (startMode) {
        if (!(startMode in constants.StartModes)) {
            const msg = "ERROR: Unrecognized start mode: " + startMode;
            return {  "statusCode": 400, "error": {"msg": msg }};
        }
        const capabilities = projectExtensions.getProjectCapabilities(selectedProjectHandler);
        if (!capabilities.hasStartMode(startMode)) {
            const msg = "ERROR: The start mode " + startMode + " is not supported for project type " + projectType;
            return { "statusCode": 400, "error": {"msg": msg }};
        }
        projectInfo.startMode = startMode;
        logger.logProjectInfo("Initial start mode for project " + projectID + " is: " + startMode, projectID, projectName);
    }

        // check if application port has been provided by Portal, if not, use the default app port of the project handler
        if (settings && settings.internalPort) {
            projectInfo.appPorts.push(settings.internalPort);
        } else if (selectedProjectHandler.getDefaultAppPort) {
            const port = selectedProjectHandler.getDefaultAppPort();
            if (Array.isArray(port))
                projectInfo.appPorts.push(...port);
            else if (port)
                projectInfo.appPorts.push(port);
        }

    if (projInfo && projInfo.debugPort) {
        projectInfo.debugPort = projInfo.debugPort;
    } else if ( selectedProjectHandler.getDefaultDebugPort ) {
        projectInfo.debugPort = selectedProjectHandler.getDefaultDebugPort();
    }

    if (projInfo && projInfo.ignoredPaths) {
        projectInfo.ignoredPaths = projInfo.ignoredPaths;
    } else if ( selectedProjectHandler.defaultIgnoredPath ) {
        projectInfo.ignoredPaths = selectedProjectHandler.defaultIgnoredPath;
    }

    // Persist the Project Settings last since it will have the higher priority over default projectInfo values
    if (settings) {
        for (const key in settings) {
            if (key == "internalDebugPort" && settings.internalDebugPort && settings.internalDebugPort.trim().length > 0) {
                projectInfo.debugPort = settings.internalDebugPort.trim();
            } else if (key == "contextRoot" && settings.contextRoot && settings.contextRoot.trim().length > 0) {
                settings.contextRoot = settings.contextRoot.replace(/^\/+/, "").replace(/\/+$/, "");
                projectInfo.contextRoot = "/" + settings.contextRoot.trim();
            } else if (key == "healthCheck" && settings.healthCheck && settings.healthCheck.trim().length > 0) {
                projectInfo.healthCheck = "/" + settings.healthCheck.trim();
            } else if (key == "mavenProfiles") {
                const mavenProfiles = settings.mavenProfiles;
                let mavenProfilesFlag = true;

                if (mavenProfiles && (mavenProfiles instanceof Array) && mavenProfiles.length > 0) {
                    for (let i = 0; i < mavenProfiles.length; i++) {
                        if (mavenProfiles[i].trim().length == 0) {
                            mavenProfilesFlag = false;
                            break;
                        }
                    }

                    if (!mavenProfilesFlag) {
                        logger.logProjectInfo("At least one of the element is empty, File-watcher will ignore the setting mavenProfiles", projectID, projectName);
                    } else {
                        projectInfo.mavenProfiles = settings.mavenProfiles;
                    }

                }
            } else if (key == "mavenProperties") {
                const mavenProperties = settings.mavenProperties;
                let mavenPropertiesFlag = true;

                if (mavenProperties && (mavenProperties instanceof Array) && mavenProperties.length > 0) {
                    for (let i = 0; i < mavenProperties.length; i++) {
                        if (mavenProperties[i].trim().length == 0) {
                            mavenPropertiesFlag = false;
                            break;
                        }
                    }

                    if (!mavenPropertiesFlag) {
                        logger.logProjectInfo("At least one of the element is empty, File-watcher will ignore the setting mavenProperties", projectID, projectName);
                    } else {
                        projectInfo.mavenProperties = settings.mavenProperties;
                    }

                }
            } else if (key == "watchedFiles") {
                const includeFiles = settings.watchedFiles.includeFiles;
                const excludeFiles = settings.watchedFiles.excludeFiles;
                let excludeFilesFlag = true;
                let includeFilesFlag = true;
                if (includeFiles && (includeFiles instanceof Array) && includeFiles.length > 0) {
                    for (let i = 0; i < includeFiles.length; i++) {
                        if (includeFiles[i].trim().length == 0) {
                            includeFilesFlag = false;
                            break;
                        }
                    }

                    if (!includeFilesFlag) {
                        logger.logProjectInfo("At least one of the element is empty, File-watcher will ignore the setting watchedFiles.includeFiles", projectID, projectName);
                    } else {
                        projectInfo.watchedFiles = settings[key]["includeFiles"];
                    }
                }

                if (excludeFiles && (excludeFiles instanceof Array) && excludeFiles.length > 0) {

                    for (let i = 0; i < excludeFiles.length; i++) {
                        if (excludeFiles[i].trim().length == 0) {
                            excludeFilesFlag = false;
                            break;
                        }
                    }

                    if (!excludeFilesFlag) {
                        logger.logProjectInfo("At least one of the element is empty, File-watcher will ignore the setting watchedFiles.excludeFiles", projectID, projectName);
                    } else {
                        projectInfo.ignoredFiles = settings[key]["excludeFiles"];
                    }
                }
            // ignoredFilesForDeamon is the project settings for filewatcher daemon
            } else if (key == "ignoredPaths") {
                let ignoredPaths = settings.ignoredPaths;
                    // Ignore empty strings in ignoredPaths
                ignoredPaths = ignoredPaths.filter( el => {
                    return el.trim().length > 0 ;
                });
                logger.logProjectInfo("ignoredPaths after removed any empty strings: " + ignoredPaths, projectID);
                if (ignoredPaths == undefined || ignoredPaths.length == 0) {
                    logger.logProjectInfo("The ignoredPaths array is empty, File-watcher will ignore the setting", projectID, projectName);
                } else {
                    projectInfo.ignoredPaths = settings.ignoredPaths;
                }
            }
        }
    }

    // Ensure the project metadata directory is created
    const projectDir = getProjectMetadataById(projectID).dir;
    try {
        await mkDirAsync(projectDir);
    } catch (err) {
        if (err.code != "EEXIST") {
            const msg = "ERROR: There was an internal error on the filesystem while creating " + projectDir;
            return { "statusCode": 500, "error": {"msg": msg }};
        }
    }

    // Save project metadata
    await saveProjectInfo(projectID, projectInfo);

    // Add the project to the status controller
    statusController.addProject(projectID);

    let operation: Operation;

    // Create operation
    operation = new Operation("create", projectInfo);

    logger.logProjectInfo("operationId: " + operation.operationId, projectID, projectName);

    // set default docker build log for initial project creation
    const projectLogDir = await logHelper.getLogDir(projectID, projectName);
    const logDirectory = path.resolve(projectLocation + "/../.logs/" + projectLogDir);
    const logFilePath = path.join(logDirectory, logHelper.buildLogs.dockerBuild + logHelper.logExtension);


    // note: state here is our own status tracker to track that the build has been started once only
    const project: BuildQueueType = {
        operation: operation,
        handler: selectedProjectHandler
    };

    // Check if project is already in the build queue, if it is then no need to add it
    const target = buildQueue.find((item) => {
        return item.operation.projectInfo.projectID === project.operation.projectInfo.projectID;
    });
    if (target) {
        logger.logProjectInfo("The project is already in the build queue so it won't be added again", projectID, projectName);
    } else {
        logger.logProjectInfo("Pushing project to build queue", projectID, projectName);
        buildQueue.push(project);
        // emit updated queued project ranks
        await emitProjectRanks();
    }

    await checkBuildQueue();

    return {
            "statusCode": 202,
            "operationId": operation.operationId,
            "logs": { "build": { "file": logFilePath } }
        };
}

/**
 * @function
 * @description Check the build queue periodically (every 5 seconds) and once a project has been created.
 *
 * @returns void
 */
async function checkBuildQueue(): Promise<void> {
    // assert the builds in progress is always between 0 to MAX_BUILDS inclusive
    logger.fileWatcherAssert(runningBuilds.length >= 0 && runningBuilds.length <= MAX_BUILDS, "Builds in progress must be between [0, MAX_BUILDS]");

    // if we have builds in the queue
    if (buildQueue.length > 0) {
        logger.logFileWatcherInfo("Found at least one build in the queue");

        // check und update builds in progress
        checkInProgressBuilds();

        // if we have space for builds to trigger, trigger the build, remove it from the queue, increase the number of builds in progress and push it on to in progress array
        if (runningBuilds.length < MAX_BUILDS) {
            logger.logFileWatcherInfo("Space available to trigger the next build");

            // remove the first project off the queue
            const buildToBeTriggered = buildQueue.shift();

            logger.logFileWatcherInfo("Metadata for next build: " + JSON.stringify(buildToBeTriggered));

            triggerBuild(buildToBeTriggered);
            runningBuilds.push(buildToBeTriggered);

            // emit updated queued project ranks
            await emitProjectRanks();
        }
    } else {
        // check und update builds in progress
        // we do this check because we need to clear runningBuilds when there are no projects in the buildQueue
        checkInProgressBuilds();
    }
}

/**
 * @function
 * @description Trigger the first build in the queue.
 *
 * @param project <Required | BuildQueueType> - The project metadata.
 *
 * @returns Promise<void>
 */
async function triggerBuild(project: BuildQueueType): Promise<void> {
    const projectInfo = project.operation.projectInfo;

    const projectID = projectInfo.projectID;
    const projectLocation = projectInfo.location;
    let watchedFiles = projectInfo.watchedFiles;
    const ignoredFiles = projectInfo.ignoredFiles;
    const selectedProjectHandler = project.handler;

    const workspaceOrigin = process.argv[2];

    const operation = project.operation;

    logger.logProjectInfo("Beginning build for " + projectID, projectID);

    // we need to check for the required files for the corresponding project handler
    if (selectedProjectHandler.requiredFiles) {
        const validator = new Validator(operation);
        await validator.validateRequiredFiles(selectedProjectHandler.requiredFiles);
        const result: any = validator.result();
        if (result.status == "failed") {
            await statusController.updateProjectStatus(statusController.STATE_TYPES.buildState, project.operation.projectInfo.projectID, statusController.BuildState.failed, "buildscripts.buildFailMissingFile");
            return;
        }
    }

    logger.logProjectInfo("Build began for " + projectID, projectID);
    await statusController.updateProjectStatus(statusController.STATE_TYPES.buildState, project.operation.projectInfo.projectID, statusController.BuildState.inProgress, "projectStatusController.buildStarted");

    // Hand off operation to appropriate handler for execution
    logger.logProjectInfo("Handing create operation to the selected project handler", projectID);
    selectedProjectHandler.create(operation);

    // if is project extention but does not specify watchedFile, watch entire project directory
    if (watchedFiles == undefined && projectInfo.projectType == projectExtensions.DOCKER_TYPE)
        // add an extra / at the end of projectLocation
        // so that we don't match projects that begin with the same name as this project when searching for inotify process
        watchedFiles = [projectLocation + "/"];

    // begin monitoring the application for file changes
    if (!process.env.IN_K8) {
        // upon filewatcher restart, we lost track of running processes in processManager
        // need to grep all running processes in fw and kill the inotify processes to prevent from multiple inotify running concurrently
        const ps = spawn("ps", ["aux"]);
        let data: string = "";
        ps.stdout.on("data", (chunk: any) => {
            data += chunk.toString("utf-8");
        });
        ps.stdout.on("end", () => {
            logger.logProjectInfo("Running processes:", projectID);
            logger.logProjectInfo(data, projectID);
            killProcesses(data, projectID, projectLocation);
            processManager.spawnDetached(projectID, "/file-watcher/scripts/project-watcher.sh", [projectLocation, workspaceOrigin, projectID, "localhost", (watchedFiles) ? watchedFiles.toString() : undefined, (ignoredFiles) ? ignoredFiles.toString() : undefined, undefined, (process.env.PORTAL_HTTPS == "true") ? "9191" : "9090", "&"], { cwd: projectLocation }, (result) => { });
        });
    }
    // To notify filewatcher daemon that the project has been added
    const eventData: NewProjectAddedEvent = {
        projectID: projectID,
        ignoredPaths: projectInfo.ignoredPaths
    };
    io.emitOnListener("newProjectAdded", eventData);
}

/**
 * @function
 * @description Check the builds in progress and filter out the ones that are completed.
 *
 * @returns void
 */
function checkInProgressBuilds(): void {
    // filter out all projects that are completed and reduce the build in progress by 1 for each such project
    runningBuilds = runningBuilds.filter((project: BuildQueueType) => {
        const projectID = project.operation.projectInfo.projectID;
        const buildStatus = statusController.getBuildState(projectID);
        if (buildStatus === statusController.BuildState.success || buildStatus === statusController.BuildState.failed) {
            logger.logProjectInfo("Build completed for " + projectID, projectID);
            return false;
        } else {
            return true;
        }
    });

    if (runningBuilds.length > 0) {
        // Only log the runningBuilds details if there is a project building, else we do not want to spam the FW log
        const currentBuilds: Array<String> = [];
        for (let i = 0; i < runningBuilds.length; i++) {
            currentBuilds.push(runningBuilds[i].operation.projectInfo.projectID);
        }
        logger.logFileWatcherInfo("Running Builds queue: " + JSON.stringify(currentBuilds));
        logger.logFileWatcherInfo("There are " + runningBuilds.length + " builds in progress");
    }
}

/**
 * @function
 * @description Emit the ranks of all projects in the queue.
 *
 * @returns Promise<void>
 */
async function emitProjectRanks(): Promise<void> {
    logger.logFileWatcherInfo("Emitting project ranks");
    buildQueue = buildQueue.filter(temp => {
        return temp != undefined;
    });
    buildQueue.forEach( async (project, index) => {
        if (project) {
            const rank = index + 1;
            const length = buildQueue.length;
            const rankStr = rank + "/" + length;
            logger.logProjectInfo("Setting rank for projectID " + project.operation.projectInfo.projectID + ": " + rankStr, project.operation.projectInfo.projectID);
            await statusController.updateProjectStatus(statusController.STATE_TYPES.buildState, project.operation.projectInfo.projectID, statusController.BuildState.queued, BUILD_KEY, undefined, undefined, await localeTrans.getTranslation(BUILD_KEY, { rank: rankStr.toString() }));
        }
    });
}

/**
 * @see [[Filewatcher.deleteProject]]
 */
export async function deleteProject(projectID: string): Promise<IDeleteProjectSuccess | IDeleteProjectFailure> {

    if (!projectID) {
        return { "statusCode": 400, "error": {"msg": "Bad request" }};
    }

    try {
        const projectMetadata = getProjectMetadataById(projectID);

        try {
            await fileStatAsync(projectMetadata.infoFile);
        } catch (err) {
            if (err.code == "ENOENT") {
                logger.logFileWatcherError("Project does not exist " + projectID);
                return { "statusCode": 404, "error": {"msg": "Project does not exist " + projectID }};
            }
        }

        const projectInfo: ProjectInfo = await getProjectInfoFromFile(projectMetadata.infoFile);
        const projectLocation = projectInfo.location;
        const projectName = projectLocation.split("/").pop();

        logger.logProjectInfo("Retrieved project information for project " + projectMetadata.infoFile, projectID, projectName);
        logger.logProjectInfo(JSON.stringify(projectInfo), projectID, projectName);
        logger.logProjectInfo("Project location: " + projectInfo.location, projectID, projectName);

        // Create operation
        const operation = new Operation("delete", projectInfo);

        logger.logProjectInfo("operationId: " + operation.operationId, projectID, projectName);

        type projectDeletionEvent = {
            operationId: string,
            projectID: string,
            status: string,
            error?: string
        };
        const event = "projectDeletion";
        const result: projectDeletionEvent = {
            operationId: operation.operationId,
            projectID: projectID,
            status: "failed"
        };

        let deleteQueuedBuildOccured = false;

        const initialLength = buildQueue.length;

        // remove the project from build queue only if the project deleted hasn't been started yet and update the other project ranks
        buildQueue = buildQueue.filter((project: BuildQueueType) => {
            if (project.operation.projectInfo.projectID === projectID) {
                logger.logFileWatcherInfo("Removing " + projectID + " from build queue due to a delete request", projectName);
                deleteQueuedBuildOccured = true;
                return false;
            } else {
                return true;
            }
        });

        // if a delete occured for a queued build, we need to restore the rank of the rest of the builds in queue
        if (deleteQueuedBuildOccured) {
            emitProjectRanks();
            logger.fileWatcherAssert((initialLength - buildQueue.length) === 1, "If project was deleted, the difference in build queue length should be exactly one");
        }

        // remove the project from in-progress queue only if the project deleted was in the in-progress build
        runningBuilds = runningBuilds.filter((project: BuildQueueType) => {
            if (project.operation.projectInfo.projectID === projectID) {
                logger.logFileWatcherInfo("Removing " + projectID + " from running builds due to a delete request", projectName);
                return false;
            } else {
                return true;
            }
        });

        projectDeletion(projectID).then(returnCode => {
            switch (returnCode) {
                case 200: {
                    result.status = "success";
                    break;
                }
                case 404: {
                    const errMsg = "Project " + projectID + "does not exist ";
                    result.error = errMsg;
                    break;
                }
                case 500: {
                    const errMsg = "Failed to remove project " + projectID;
                    result.error = errMsg;
                    break;
                }
            }
            io.emitOnListener(event, result);
        }).catch(err => {
            const errMsg = "Internal error occurred. Failed to remove project " + projectID;
            logger.logFileWatcherError(errMsg, projectName);
            logger.logFileWatcherError(err, projectName);
            result.error = errMsg;
            io.emitOnListener(event, result);
        });
        return { "statusCode": 202, "operationId": operation.operationId };
    } catch (err) {
        let returnCode: 500 | 404;
        returnCode = 500;
        if (err.code == "ENOENT")
            returnCode = 404;
        const errMsg = "Failed to remove project " + projectID;
        logger.logProjectError(errMsg, projectID);
        logger.logProjectError(err, projectID);
        return { "statusCode": returnCode, "error": { "msg": errMsg }};
    }
}

/**
 * @see [[Filewatcher.getProjectLogs]]
 */
export async function logs(projectID: string): Promise<IGetLogsSuccess | IGetLogsFailure> {
    if (!projectID) {
        return { "statusCode": 400, "error": { "msg": "Bad request" } };
    }

    try {
        const projectMetadata = getProjectMetadataById(projectID);
        const projectInfo = await getProjectInfoFromFile(projectMetadata.infoFile);

        if (!projectInfo) {
            return { "statusCode": 404, "error": { "msg": "Project does not exist " + projectID } };
        }

        const projectLocation = projectInfo && projectInfo.location ? projectInfo.location : undefined;

        if (!projectLocation || !await utils.asyncFileExists(projectLocation)) {
            const errMsg = "The project location " + projectLocation + " does not exist.";
            logger.logProjectInfo(errMsg, projectID);
            return { "statusCode": 404, "error": { "msg": errMsg } };
        }

        logger.logFileWatcherInfo("Fetching logs for project " + projectID);
        const logsJson = await projectUtil.getProjectLogs(projectInfo);
        const logsResult: IGetLogsSuccess = {
            statusCode: 200,
            logs: logsJson
        };
        return logsResult;
    } catch (err) {
        let returnCode: IGetLogsFailure["statusCode"];
        if (err.code == "ENOENT")
            returnCode = 404;
        else
            returnCode = 500;
        const errMsg = "Failed to get logs for project " + projectID;
        logger.logProjectError(errMsg, projectID);
        logger.logProjectError(err, projectID);
        return { "statusCode": returnCode, "error": { "msg": errMsg } };
    }
}

/**
 * @see [[Filewatcher.shutdown]]
 */
export async function shutdown(): Promise<IShutdownSuccess | IShutdownFailure> {
    try {
        logger.logFileWatcherInfo("Shutting down filewatcher.");

        // clear build queue before shutdowning down all projects
        // by setting the original array length to 0 to avoid creating a new empty array
        buildQueue.length = 0;
        runningBuilds.length = 0;

        await projectUtil.shutdownProjects();
        return { statusCode: 202 };
    } catch (err) {
        logger.logFileWatcherError("Shutting down filewatcher projects.");
        return { statusCode: 500, "error": { "msg": "Internal error occurred during filewatcher shutdown." } };
    }

}

/**
 * @function
 * @description Kill all processes related to the project.
 *
 * @param psOutput <Required | String> - The output of the ps command for watched processes.
 * @param projectID <Required | String> - An alphanumeric identifier for a project.
 * @param projectLocation <Required | String> - The project location in the workspace.
 *
 * @returns void
 */
function killProcesses(psOutput: string, projectID: string, projectLocation: string): void {
    let projectName = projectLocation.split("/").pop();

    if (projectLocation.endsWith("/")) {
        projectLocation = projectLocation.substring(0, projectLocation.length - 2);
        projectName = projectLocation.split("/").pop();
        logger.logProjectInfo("projectLocation: " + projectLocation, projectID, projectName);
    }
    // Try to match a project-watcher process similar to the following
    // 76 root       0:00 {project-watcher} /bin/bash /file-watcher/scripts/project-watcher.sh /codewind-workspace/springy /Users/rajiv/git/microclimate/codewind-workspace &
    const projectWatcherProcessIdentifier = "/file-watcher/scripts/project-watcher.sh " + projectLocation + " "; // the space is required here so that we don't match projects that begin with the same name as this project

    // Try to match an inotifywait process similar to the following
    // 105 root       0:00 inotifywait --format %T:%f --timefmt %s -e CREATE -e CLOSE_WRITE -e MODIFY -e DELETE -r -m /codewind-workspace/springy/src /codewind-workspace/springy/pom.xml /microclim
    const inotifywaitProcessIdentifier = projectLocation + "/";

    const inotifywaitIds = [];
    const projectWatcherIds = [];

    const watcherProcesses = psOutput.split(/\r?\n/);
    // Look up the watcher processes for this project and kill them
    for (let i = 0; i < watcherProcesses.length; i++) {
        const psLine = watcherProcesses[i];
        let id;
        if (psLine.includes(projectWatcherProcessIdentifier) && psLine.includes("{project-watcher}")) {
            id = psLine.match(/[^\s]+/).toString();
            projectWatcherIds.push(id);
            logger.logProjectInfo("Found project watcher process with id " + id, projectID, projectName);
        } else if (psLine.includes(inotifywaitProcessIdentifier) && psLine.includes("inotifywait")) {
            id = psLine.match(/[^\s]+/).toString();
            inotifywaitIds.push(id);
            logger.logProjectInfo("Found inotifywait process with id " + id, projectID, projectName);
        }
    }

    for (let i = 0; i < inotifywaitIds.length; i++) {
        const id = inotifywaitIds[i];
        if (id && !isNaN(parseInt(id))) {
            logger.logProjectInfo("Killed inotify process with id " + id + " for project " + projectID, projectID, projectName);
            try {
                process.kill(parseInt(id));
            } catch (err) {
                logger.logProjectError("Failed to kill process " + id + " : " + err, projectID, projectName);
            }
        }
    }

    for (let i = 0; i < projectWatcherIds.length; i++) {
        const id = projectWatcherIds[i];
        if (id && !isNaN(parseInt(id))) {
            logger.logProjectInfo("Killed watcher process with id " + id + " for project " + projectID, projectID, projectName);
            try {
                process.kill(parseInt(id));
            } catch (err) {
                logger.logProjectError("Failed to kill process " + id + " : " + err, projectID, projectName);
            }
        }
    }
}

/**
 * @function
 * @description Helper function for project deletion.
 *
 * @param projectID <Required | String> - An alphanumeric identifier for a project.
 *
 * @returns Promise<number>
 */
export async function projectDeletion(projectID: string): Promise<number> {
    let returnCode;
    try {
        // Look up project metadata from projectID
        const projectMetadata = getProjectMetadataById(projectID);
        const projectInfo: ProjectInfo = await getProjectInfoFromFile(projectMetadata.infoFile);
        const projectLocation = projectInfo.location;
        const projectName = projectLocation.split("/").pop();

        logger.logProjectInfo("Retrieved project information for project " + projectMetadata.infoFile, projectID, projectName);
        logger.logProjectInfo(JSON.stringify(projectInfo), projectID, projectName);
        logger.logProjectInfo("Project location: " + projectInfo.location, projectID, projectName);
        logger.logProjectInfo("Deleting project " + projectID, projectID);

        // Stop monitoring the project
        statusController.deleteProject(projectID);
        projectUtil.deleteProjectFromList(projectID);

        // Kill processes associated with the project
        if (process.env.IN_K8) {
            const inotifyArgs: any = {
                projectID: projectID,
                projectLocation: projectLocation
            };
            projectList.delete(projectID);
        }
        else {
            const ps = spawn("ps", ["aux"]);
            let data: string = "";
            ps.stdout.on("data", (chunk: any) => {
                data += chunk.toString("utf-8");
            });
            ps.stdout.on("end", () => {
                logger.logProjectInfo("Running processes:", projectID);
                logger.logProjectInfo(data, projectID);
                killProcesses(data, projectID, projectLocation);
            });
        }


        // Call delete on the associated project handler
        if (projectInfo.projectType) {
            const selectedProjectHandler = await projectExtensions.getProjectHandler(projectInfo);
            const returnVal = await selectedProjectHandler.deleteContainer(projectInfo);
            if (returnVal instanceof Error) {
                returnCode = 500;
            } else {
                returnCode = 200;
            }
        }

        // Delete the project metadata
        await deleteFolder(projectMetadata.dir);
        delete projectInfoCache[projectMetadata.infoFile];
        logger.logProjectInfo("Project info cache is " + JSON.stringify(projectInfoCache), projectID, projectName);
        logger.logProjectInfo("Successfully deleted " + projectID, projectID, projectName);

        // removing log directory for the project
        logger.logFileWatcherInfo("Removing project logs directory");
        const dirName = await logHelper.getLogDir(projectID, projectName);
        await logHelper.removeLogDir(dirName, constants.projectConstants.projectsLogDir);

        // clear it from log list cache
        delete logHelper.logFileLists[projectID];

        return returnCode;
    } catch (err) {
        returnCode = 500;
        if (err.code == "ENOENT")
            returnCode = 404;
        const errMsg = "Failed to remove project " + projectID;
        logger.logProjectError(errMsg, projectID);
        logger.logProjectError(err, projectID);
        return returnCode;
    }
}

/**
 * @function
 * @description Get the metadata of the project by project id.
 *
 * @param projectID <Required | String> - An alphanumeric identifier for a project.
 *
 * @returns ProjectMetadata
 */
export function getProjectMetadataById(projectID: string): ProjectMetadata {
    const projectDir = constants.projectConstants.projectsDataDir + projectID + "/";
    const projectLogDir = constants.projectConstants.projectsLogDir + "";

    return {
        dir: projectDir,
        infoFile: projectDir + projectID + ".json",
        logDir: projectLogDir
    } as ProjectMetadata;
}

/**
 * @function
 * @description Get the project info from file.
 *
 * @param infoFile <Required | String> - Location of the info file.
 *
 * @returns Promise<any>
 */
export async function getProjectInfoFromFile(infoFile: string, ignoreLog?: boolean): Promise<any> {
    if (projectInfoCache[infoFile]) {
        return JSON.parse(projectInfoCache[infoFile]);
    }
    let data: string;
    try {
        data = await readFileAsync(infoFile, "utf8");
    } catch (err) {
        if (!ignoreLog) {
            logger.logFileWatcherError("Failed to find project information related to file " + infoFile);
        }
    }

    return data ? JSON.parse(data) : data;
}

/**
 * @function
 * @description Get the project id by providing the project name.
 *
 * @param projectName <Required | String> - The name of the project.
 *
 * @returns Promise<any>
 */
export async function getProjecIDByProjectName(projectName: string): Promise<any> {
    const projectInfoFile = constants.projectConstants.projectsInfoDir + projectName + ".inf";
    const data = await readFileAsync(projectInfoFile, "utf8");
    const projectInfo = JSON.parse(data);
    const projectID = projectInfo.projectID;
    return projectID;
}

/**
 * @function
 * @description Helper function to delete a file from a given folder.
 *
 * @param dir <Required | String> - The location of the directory.
 * @param file <Required | String> - The name of the file.
 *
 * @returns Promise<void>
 */
function deleteFile(dir: string, file: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const currentPath = path.join(dir, file);

        // Check whether the file is a directory
        fs.lstat(currentPath, (err, stats) => {
            if (err) {
                // If the file doesn't exist our work is done
                return resolve();
            }
            if (stats.isDirectory()) {
                // The path is a directory
                resolve(deleteFolder(currentPath));
            } else {
                fs.access(currentPath, (err) => {
                    if (err) {
                        // If the file doesn't exist our work is done
                        return resolve();
                    }

                    // Delete the file
                    fs.unlink(currentPath, (err) => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    });
                });
            }
        });
    });
}

/**
 * @function
 * @description Helper function to delete a folder.
 *
 * @param dir <Required | String> - The location of the directory.
 *
 * @returns Promise<void>
 */
export function deleteFolder(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        // Prevent deletion of the entire disk
        if (dir === "/") {
            return reject(Error("Invalid argument " + dir));
        }
        fs.access(dir, (err) => {
            if (err) {
                // If the folder doesn't exist our work is done
                return resolve();
            }
            // List all files in the directory
            fs.readdir(dir, (err, files) => {
                if (err) {
                    return reject(err);
                }
                // Delete all files in the directory
                Promise.all(files.map((file) => {
                    return deleteFile(dir, file);
                })).then(() => {
                    fs.rmdir(dir, (err) => {
                        if (err) {
                            return reject(err);
                        }
                        resolve();
                    });
                }).catch(reject);
            });
        });
    });
}

/**
 * @see [[Filewatcher.performProjectAction]]
 */
export async function projectAction(req: IProjectActionParams): Promise<IProjectActionSuccess | IProjectActionFailure> {

    // Get the type of action from the request
    const requestedAction = req.action;
    if (!requestedAction || !actionMap.has(requestedAction)) {
        return { "statusCode": 400, "error": { "msg": "Unknown action requested: " + requestedAction }};
    }

    try {
        let statusCode;
        if (requestedAction === "disableautobuild" || requestedAction === "reconfigWatchedFiles") {
            statusCode = 200;
        } else {
            // validate, enableautobuild and action build are all async calls
            statusCode = 202;
        }

        const response = await actionMap.get(requestedAction)(req);
        response.statusCode = statusCode;
        return response;
    } catch (err) {
        let returnCode: 404 | 400 | 500;
        returnCode = 500;
        if (err.name == "BAD_REQUEST") {
            returnCode = 400;
        }
        else if (err.code == "ENOENT" || err.name == "FILE_NOT_EXIST") {
            returnCode = 404;
        }

        const msg = `An error occurred while executing projectAction:\n ${JSON.stringify(req)}\n ${returnCode}: ${err.message}`;
        logger.logFileWatcherError(msg);

        return { "statusCode": returnCode, "status": "failed", "error": { "msg": err.message } };
    }
}


/**
 * @see [[Filewatcher.reconfigProjectSpecification]]
 */
export async function projectSpecification(req: IProjectSpecificationParams): Promise<IProjectSpecificationFailure | IProjectSpecificationSuccess> {

    // Get the type of projectSpecification from the request
    const projectID = req.projectID;
    const settings = req.settings;

    if (!projectID) {
        return { "statusCode": 400, "error": { "msg": "BAD_REQUEST: The project id was not provided. "}};
    }

    if (!settings) {
        return { "statusCode": 400, "error": { "msg": "BAD_REQUEST: The settings were not provided. "}};
    }

    try {
        const retval = await projectSpecifications.projectSpecificationHandler(projectID, settings);
        return { "statusCode": 202, operationId: retval.operationId};
    } catch (err) {
        let returnCode: 400 | 404 | 500;
        returnCode = 500;
        if (err.name == "BAD_REQUEST") {
            returnCode = 400;
        }
        else if (err.code == "ENOENT" || err.name == "FILE_NOT_EXIST") {
            returnCode = 404;
        }
        const msg = `An error occurred while reconfig the project specification setting:\n ${JSON.stringify(req)}\n ${returnCode}: ${err.message}`;
        logger.logProjectError(msg, projectID);

        return { "statusCode": returnCode, "status": "failed", "error": { "msg": err.message } };
    }
}

/**
 * @function
 * @description Update project information with object key value pairs.
 *
 * @param projectID <Required | String> - An alphanumeric identifier for a project.
 * @param keyValuePair <Required | UpdateProjectInfoPair> - An object with required key value pair and boolean to specify saving the file.
 *
 * @returns Promise<ProjectInfo>
 */
export async function updateProjectInfo(projectID: string, keyValuePair: UpdateProjectInfoPair): Promise<ProjectInfo> {
    const projectInfo = await projectUtil.getProjectInfo(projectID);
    if (!projectInfo) {
        throw new Error("Failed to retrieve project information.");
    }

    // appPorts is the only property in projectInfo which is an array, so handle appPorts specifically
    // FYI: appPorts atm only contains one port, the port FW pings to for app status
    if (keyValuePair.key == "appPorts") {
        projectInfo.appPorts.pop();
        projectInfo.appPorts.push(keyValuePair.value);
    } else {
        projectInfo[keyValuePair.key] = keyValuePair.value;
    }

    if (keyValuePair.saveIntoJsonFile === undefined) {
        keyValuePair.saveIntoJsonFile = true;
    }

    await saveProjectInfo(projectID, projectInfo, keyValuePair.saveIntoJsonFile);

    return projectInfo;
}

/**
 * @function
 * @description Save the project info to the file.
 *
 * @param projectID <Required | String> - An alphanumeric identifier for a project.
 * @param projectInfo - JSON object for the project information.
 * @param saveIntoJsonFile - Boolean to specify saving the information to file. Default = true.
 *
 * @returns void
 */
export function saveProjectInfo(projectID: string, projectInfo: ProjectInfo, saveIntoJsonFile: boolean = true): Promise<void> {
    return new Promise((resolve) => {
        const projectJSON = JSON.stringify(projectInfo);
        const infoFile = getProjectMetadataById(projectID).infoFile;
        projectInfoCache[infoFile] = projectJSON;
        const projectName = projectInfo.location.split("/").pop();
        logger.logProjectInfo(JSON.stringify(projectInfoCache), projectID, projectName);
        if (saveIntoJsonFile) {
            fs.writeFile(infoFile, projectJSON, "utf8", (err) => {
                if (err) {
                    logger.logProjectError("Error writing project info to file " + infoFile, projectID, projectName);
                    logger.logProjectError(err.message, projectID, projectName);
                }
                logger.logProjectInfo("Finished writing file " + infoFile, projectID, projectName);
                resolve();
            });
        } else {
            resolve();
        }
    });
}

/**
 * @see [[Filewatcher.checkNewLogFile]]
 */
 export async function checkNewLogFile(projectID: string, type: string): Promise<ICheckNewLogFileSuccess | ICheckNewLogFileFailure> {
    if (!projectID) {
        return { "statusCode": 400, "error": { "msg": "Bad request" }};
    }

     if (!type || (type != "app" && type != "build")) {
        return { "statusCode": 400, "error": { "msg": "Bad request" }};
    }

    try {
        const projectMetadata = getProjectMetadataById(projectID);
        const projectInfo = await getProjectInfoFromFile(projectMetadata.infoFile);

        logger.logFileWatcherInfo("Fetching logs for project " + projectID);
        const logsJson: projectUtil.ProjectLog = await projectUtil.getProjectLogs(projectInfo);
        let result: ILogFilesResult;
        if (type === "build") {
            result = {
                "projectID": projectID,
                "type": type,
                "build": logsJson.build
            };
        } else {
            result = {
                "projectID": projectID,
                "type": type,
                "app": logsJson.app
            };
        }

        if (result[type].files.length === 0) {
            // we don't have any files yet, so we call the api again
            return checkNewLogFile(projectID, type);
        } else if (!logHelper.logFileLists[projectID]) {
            // when the first time a log file is available for a new project
            logHelper.logFileLists[projectID] = {};
            logHelper.logFileLists[projectID][type] = result[type];
            await io.emitOnListener("projectLogsListChanged", result);
            return { "statusCode": 200, "logs": result };
        } else {
            if (!logHelper.logFileLists[projectID][type]) {
                // when a log file is emitted but of a different type, i.e build log exists but an app log is emitted
                logHelper.logFileLists[projectID][type] = result[type];
                await io.emitOnListener("projectLogsListChanged", result);
                return { "statusCode": 200, "logs": result };
            } else {
                // this is the case where the same type of log file exists, so we check if the list is the same as the cached list
                // for codewind: we don't care about the order of the files list, so we just check if the cache list is a subset of the original list and vice versa
                const cache = logHelper.logFileLists[projectID][type].files;
                const original = result[type].files;
                const areBothArraysEqual = cache.every((val: string) => original.includes(val)) && original.every((val: string) => cache.includes(val));

                // if the list is different, we emit the new list and update the cache
                if (!areBothArraysEqual) {
                    logHelper.logFileLists[projectID][type] = result[type];
                    await io.emitOnListener("projectLogsListChanged", result);
                    return { "statusCode": 200, "logs": result };
                } else {
                    // if the log file list didn't change just return
                    return { "statusCode": 200};
                }
            }
        }
    } catch (err) {
        let returnCode: 404 | 500;
        if (err.code == "ENOENT")
            returnCode = 404;
        else
            returnCode = 500;
        const errMsg = "Failed to get logs for project " + projectID;
        logger.logProjectError(errMsg, projectID);
        logger.logProjectError(err, projectID);
        return { "statusCode": returnCode, "error": { "msg": errMsg }};
    }
}
export interface ICreateProjectParams {
    projectID: string;
    projectType: string;
    location: string;
    settings?: IProjectSettings;
    startMode?: string;
    extension?: IProjectExtension;
}

export interface IProjectExtension {
    name: string;
    [key: string]: any;
}

export interface IProjectSettings {
    internalPort?: string;
    internalDebugPort?: string;
    contextRoot?: string;
    healthCheck?: string;
    mavenProfiles?: string[];
    mavenProperties?: string[];
    watchedFiles?: IWatchedFiles;
    ignoredPaths?: string[];
}

export interface IProjectActionParams {
    action: string;
    projectType?: string;
    location?: string;
    projectID?: string;
    startMode?: string;
}

export interface IProjectSpecificationParams {
    projectID: string;
    settings: IProjectSettings;
}

export interface IWatchedFiles {
    includeFiles?: string[];
    excludeFiles?: string[];
}

export interface ICreateProjectSuccess {
    statusCode: 202;
    operationId: string;
    logs: { build: { file: string } };
}

export interface ICreateProjectFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
}

export interface IGetProjectTypesSuccess {
    statusCode: 200;
    types: string[];
}

export interface IGetProjectTypesFailure {
    statusCode: 404 | 500;
    error: { msg: string };
}

export interface IGetProjectCapabilitiesSuccess {
    statusCode: 200;
    capabilities: ProjectCapabilities;
}

export interface IGetProjectCapabilitiesFailure {
    statusCode: 400 | 404;
    error: { msg: string };
}

export interface IProjectActionFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
    status?: "failed";
}

export interface IProjectActionSuccess {
    statusCode: 200 | 202;
    operationId?: string;
    status?: "success";
}
export interface IProjectSpecificationFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
    status?: "failed";
}

export interface IProjectSpecificationSuccess {
    statusCode: 200 | 202;
    operationId: string;
}

export interface IGetLogsSuccess {
    statusCode: 200;
    logs: projectUtil.ProjectLog;
}

export interface IGetLogsFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
}

export interface IDeleteProjectSuccess {
    statusCode: 202;
    operationId: string;
}

export interface IDeleteProjectFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
}

export interface IShutdownSuccess {
    statusCode: 202;
}

export interface IShutdownFailure {
    statusCode: 500;
    error: { msg: string };
}

export interface ILogFilesResult {
    projectID: string;
    type: "app" | "build";
    app?: AppLog;
    build?: BuildLog;
}

export interface ICheckNewLogFileSuccess {
    statusCode: 200;
    logs?: ILogFilesResult;
}

export interface ICheckNewLogFileFailure {
    statusCode: 400 | 404 | 500;
    error: { msg: string };
}

export interface NewProjectAddedEvent {
    projectID: string;
    ignoredPaths: string[];
}
