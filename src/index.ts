import { Client, FileInfo, AccessOptions, FileType } from "basic-ftp";
import fs from "fs";
import mkdirp from "mkdirp";
import chokidar from "chokidar";

import express from "express";
import { server, connection } from "websocket";

import http from "http";
import path from "path";

import { exit } from "process";
import { QueueElement } from "./QueueElement";
import { ActionType } from "./ActionType";
import { MessageType } from "./MessageType";

// Config variables

let downloadDirectory = "./";
let host = "";
let user = "";
let password = "";
let folderSizeDepth = 5;
let checkServerIdentity = true;

// Ftp client and access options

const downloadClient = new Client();
const accessOptions: AccessOptions = {
  host: host,
  user: user,
  password: password,
  secure: true,
  secureOptions: {},
};

// Parse config

let config;

try {

  config = JSON.parse(fs.readFileSync("config.json", { encoding: "utf-8" }));

  // Host: required

  if (!isNEString(config.host)) throw "Host cannot be empty";
  host = config.host;

  // Username: required

  if (!isNEString(config.user)) throw "User cannot be empty";
  user = config.user;

  // Password: required

  if (!isNEString(config.password)) throw "Password cannot be empty";
  password = config.password;

  // Certificate: optional [none]
  if (isNEString(config.certificate)) {
    accessOptions.secureOptions.ca = fs.readFileSync(config.certificate, { encoding: "utf-8" });
  }

  // Local downloaddiretory: optional ['./']
  if (isNEString(config.downloadDirectory)) {
    downloadDirectory = config.downloadDirectory;
  }

  // Folder size depth: optional [5]
  if (typeof config.folderSizeDepth === "number") {
    folderSizeDepth = config.folderSizeDepth;
  }

  // Check server identity: optional [true]
  if (config.checkServerIdentity === "false") {
    accessOptions.secureOptions.checkServerIdentity = (): Error => {
      return null;
    };
  }
} catch (e) {
  console.log("Config load error:", e);
  exit(1);
}

downloadDirectory = path.resolve(downloadDirectory);

// Queue

const downloadQueue: QueueElement[] = [];

let isDownloadingQueue = false;

// File watching

chokidar
  .watch(downloadDirectory, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
    },
  })
  .on("all", (event, path) => {
    switch (event) {
      case "add":
      case "unlink":
      case "addDir":
      case "unlinkDir":
        onFile(path, event === "add" || event === "addDir");
        break;
    }
  });

function onFile(changedFilePath: string, added: boolean) {
  const size = added
    ? (() => {
        try {
          return fs.statSync(changedFilePath).size;
        } catch (e) {
          return 0;
        }
      })()
    : 0;
  const relativePath = getRelativePath(changedFilePath);
  sendToAll(
    JSON.stringify({
      type: MessageType.LIST_ELEMENT,
      data: {
        path: relativePath,
        existsLocally: added,
        localSize: size,
      },
    })
  );
}

// HTTP Server

const port = process.env.PORT || 3000;
const app = express();
const httpServer = http.createServer(app);
app.use(express.static(path.join(path.resolve(path.dirname(__dirname)), "public")));
httpServer.listen(port, () => {
  return console.log(`server is listening on ${port}`);
});

// WebSocket

const connections: connection[] = [];

const wsServer = new server({
  httpServer: httpServer,
  autoAcceptConnections: true,
});

wsServer.on("connect", (connection) => {
  connections.push(connection);

  connection.on("message", (message) => {
    try {
      const msg = JSON.parse(message.utf8Data);

      switch (msg.action) {
        case ActionType.LIST:
          listPath(connection, msg.path);
          break;
        case ActionType.DELETE:
          deletePath(connection, msg.path);
          break;
        case ActionType.DOWNLOAD:
          addToQueue(connection, msg.path);
          break;
        case ActionType.LIST_QUEUE:
          sendQueueList();
          break;
        case ActionType.QUEUE_CANCEL:
          cancelQueueElement(connection, msg.path);
          break;
      }
    } catch (e) {
      sendError(connection, `Action error: could not parse message (${e}) `);
    }
  });

  connection.on("close", () => {
    const index = connections.indexOf(connection);
    if (index > -1) {
      connections.splice(index, 1);
    }
  });
});

async function listPath(connection: connection, directory: string) {
  if (!checkPathSafe(directory)) {
    sendError(connection, "Invalid list path");
    return;
  }

  directory = directory ? getCleanPath(directory) : "";

  let list;
  try {
    list = await listFtp(directory.replace(/\\/g, "/"));
  } catch (e) {
    console.error(e);
    sendError(connection, `List error: ${e}`);
    return;
  }

  const mappedList = list
    .filter((el) => !el.name.startsWith("."))
    .map((el) => {
      const absPath = path.join(downloadDirectory, getCleanPath(path.join(directory ? directory : "", el.name)));
      let existsLocally = true;
      let localSize = 0;
      try {
        localSize = fs.statSync(absPath).size;
      } catch (e) {
        existsLocally = false;
      }
      return {
        name: el.name,
        path: getCleanPath(path.join(directory ? directory : "", el.name)),
        existsLocally: existsLocally,
        type: el.type,
        size: el.size,
        localSize: localSize,
      };
    });

  const message = JSON.stringify({
    type: MessageType.LIST,
    data: (!checkLocalPathSafe(path.dirname(path.resolve(path.join(downloadDirectory, directory))))
      ? []
      : [
          {
            name: "Parent directory",
            path: path.dirname(directory) ? path.dirname(directory) : "",
            existsLocally: true,
            type: -1,
          },
        ]
    ).concat(mappedList),
  });
  connection.send(message);
}

function sendError(connection: connection, error: string) {
  connection?.send(JSON.stringify({
    type: MessageType.ERROR,
    data: error,
  }));
}

function sendSuccess(connection: connection, message: string) {
  connection?.send(JSON.stringify({
    type: MessageType.SUCCESS,
    data: message,
  }));
}

function sendErrorToAll(error: string) {
  sendToAll(
    JSON.stringify({
      type: MessageType.ERROR,
      data: error,
    })
  );
}

function sendSuccesToAll(message: string) {
  sendToAll(
    JSON.stringify({
      type: MessageType.SUCCESS,
      data: message,
    })
  );
}

function deletePath(connection: connection, deletePath: string) {
  if (!isNEString(deletePath)) {
    sendError(connection, "Delete error: empty delete path");
    return;
  }

  const cleanPath = getCleanPath(deletePath);

  if (!checkPathSafe(cleanPath)) {
    sendError(connection, "Delete error: invalid delete path");
    return;
  }

  const actualDeletePath = path.join(downloadDirectory, cleanPath);

  try {
    rmSync(actualDeletePath);
    sendSuccess(connection, `Sucessfully deleted '${cleanPath}'`)
  } catch (e) {
    console.error(e);
    sendError(connection, `Delete error for ${cleanPath} (${e})`);
  }
}

// Download queue

async function addToQueue(connection: connection, addToQueuePath: string) {
  if (!checkPathSafe(addToQueuePath)) {
    sendError(connection, "Queue add error: invalid download path");
    return;
  }

  const cleanPath = getCleanPath(addToQueuePath);
  const ftpParentPath = path.dirname(cleanPath).replace(/\\/g, "/");
  const ftpBaseName = path.basename(cleanPath);

  if (downloadQueue.find((el) => el.path == cleanPath)) {
    sendError(connection, "Queue add error: element already in queue");
    return;
  }

  let file: FileInfo;

  try {
    const list = await listFtp(ftpParentPath);
    file = list.find((el) => el.name === ftpBaseName);
  } catch (e) {
    console.error(e);
    sendError(connection, `Queue add error: could not get file details (${e})`);
    return;
  }

  if (file) {
    const queueElement: QueueElement = {
      path: getCleanPath(addToQueuePath),
      name: path.basename(getCleanPath(addToQueuePath)),
      type: file?.type,
      size: 0,
      progress: 0,
      isDownloading: false,
      isCancelled: false,
    };

    downloadQueue.push(queueElement);

    sendQueueList();
    startQueue();

    calculateFTPSize(file, queueElement);
  } else {
    sendError(connection, "Queue add error: could not determine file type");
  }
}

async function calculateFTPSize(file: FileInfo, queueElement: QueueElement) {
  const browseClient = new Client();
  await browseClient.access(accessOptions);

  let size: number;
  const elPath = queueElement.path.replace(/\\/g, "/");

  try {
    if (file.type === FileType.File) {
      size = await browseClient.size(elPath);
      browseClient.close();
      queueElement.size = size;
      sendToAll(
        JSON.stringify({
          type: MessageType.QUEUE_ELEMENT,
          data: {
            path: queueElement.path,
            size: queueElement.size,
          },
        })
      );
    } else if (file.type === FileType.Directory) {
      const updateSizeIntervalId = setInterval(() => {
        sendToAll(
          JSON.stringify({
            type: MessageType.QUEUE_ELEMENT,
            data: {
              path: queueElement.path,
              size: queueElement.size,
            },
          })
        );
      }, 1000);

      getFolderSize(elPath, 0, queueElement)
        .then(() => {
          clearInterval(updateSizeIntervalId);
          sendToAll(
            JSON.stringify({
              type: MessageType.QUEUE_ELEMENT,
              data: {
                path: queueElement.path,
                size: queueElement.size,
              },
            })
          );
          browseClient.close();
        })
        .catch((e) => {
          clearInterval(updateSizeIntervalId);
          sendErrorToAll(`Queue error: Could not determine queue element size of folder (${e})`);
          console.error(e);
        });
    } else {
      sendErrorToAll("Queue error: Could not determine queue element size for non folder and non file type");
    }
  } catch (e) {
    browseClient.close();
    console.error(e);
    sendErrorToAll(`Queue error: Could not determine queue element size (${e}) `);
    return;
  }

  async function getFolderSize(folderPath: string, level: number, queueElement: QueueElement) {

    if (queueElement.isCancelled || level > folderSizeDepth) return 0;

    const list = await browseClient.list(folderPath);

    for (const element of list) {
      const elPath = path.join(folderPath, element.name).replace(/\\/g, "/");

      if (element.type === FileType.File) {
        queueElement.size += element.size;
      } else if (element.type === FileType.Directory) {
        await getFolderSize(elPath, level + 1, queueElement);
      }
    }
  }
}

function startQueue() {
  if (isDownloadingQueue) return;

  isDownloadingQueue = true;

  return getDownloadNextElementPromise();

  function getDownloadNextElementPromise(): Promise<void> {
    const queueElement = downloadQueue[0];

    if (queueElement) {
      queueElement.isDownloading = true;
      sendToAll(
        JSON.stringify({
          type: MessageType.QUEUE_ELEMENT,
          data: {
            path: queueElement.path,
            isDownloading: queueElement.isDownloading,
          },
        })
      );
      return downloadQueueElement(queueElement).then(getDownloadNextElementPromise);
    }

    isDownloadingQueue = false;
    return Promise.resolve();
  }
}

async function downloadQueueElement(queueElement: QueueElement) {
  const downloadPath = queueElement.path;
  const localPath = path.join(downloadDirectory, downloadPath);
  const localParentPath = path.dirname(localPath);
  const cleanPath = getCleanPath(downloadPath);
  const ftpPath = cleanPath.replace(/\\/g, "/");

  try {
    downloadClient.trackProgress((info) => {
      if (info.type === "download") {
        queueElement.progress = info.bytesOverall;
        sendToAll(
          JSON.stringify({
            type: MessageType.QUEUE_ELEMENT,
            data: {
              path: queueElement.path,
              progress: queueElement.progress,
            },
          })
        );
      }
    });

    const stopTrackingProgress = () => {
      downloadClient.trackProgress();
    };

    await connectDownloadClient();
    if (queueElement.type === 2) {
      await downloadClient.downloadToDir(localPath, ftpPath);
      stopTrackingProgress();
    } else if (queueElement.type === 1) {
      await mkdirp(localParentPath);
      await downloadClient.downloadTo(localPath, ftpPath);
      stopTrackingProgress();
    }
    closeDownloadClient();
    downloadQueue.splice(downloadQueue.indexOf(queueElement), 1);
    sendQueueList();
    sendSuccesToAll(`Succesfully downloaded ${queueElement.name}`)
  } catch (e) {
    downloadQueue.splice(downloadQueue.indexOf(queueElement), 1);
    sendQueueList();

    if (!queueElement.isCancelled) {
      sendErrorToAll(`Download error for '${queueElement?.path}' (${e}`);
      console.error(e);
    } else {
      try {
        rmSync(localPath);
      } catch (e) {
        sendErrorToAll(`Queue cancel error: could not remove file remnants for ${queueElement.path} (${e})'`);
      }
    }
  }
}

function sendQueueList() {
  sendToAll(
    JSON.stringify({
      type: MessageType.QUEUE,
      data: downloadQueue,
    })
  );
}

function sendToAll(message: string) {
  connections.forEach((connection) => connection.send(message));
}

function cancelQueueElement(connection: connection, cancelPath: string) {
  const cleanPath = getCleanPath(cancelPath);
  const index = downloadQueue.findIndex((el) => el.path === cleanPath);
  const queueElement = downloadQueue[index];

  if (queueElement) {
    if (queueElement.isDownloading) {
      queueElement.isCancelled = true;
      if (!downloadClient.closed) downloadClient.close();
    } else {
      downloadQueue.splice(index, 1);
      sendQueueList();
    }
  } else {
    sendError(connection, "Queue cancel error: element not in queue");
  }
}

// FTP client actions

function connectDownloadClient() {
  return downloadClient.access(accessOptions);
}

function closeDownloadClient() {
  return downloadClient.close();
}

async function listFtp(listPath: string): Promise<FileInfo[]> {
  const client = new Client();
  await client.access(accessOptions);
  try {
    return await client.list(listPath);
  } catch (e) {
    client.close();
    throw e;
  }
}

// Util

function isNEString(value: unknown) {
  return typeof value === "string" && value.length > 0;
}

function checkPathSafe(checkPath: string) {
  const absCheckPath = path.resolve(path.join(downloadDirectory, checkPath));

  return checkLocalPathSafe(absCheckPath);
}

function checkLocalPathSafe(checkPath: string) {
  const absCheckPath = path.resolve(checkPath);

  if (downloadDirectory === absCheckPath) return true;

  const relative = path.relative(downloadDirectory, absCheckPath);

  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function getCleanPath(uncleanPath: string) {
  const resolved = path.resolve(path.join(downloadDirectory, uncleanPath));

  return path.relative(downloadDirectory, resolved);
}

function getRelativePath(absolutePath: string) {
  return path.relative(downloadDirectory, absolutePath);
}

function rmSync(deletePath: string) {
  if (fs.statSync(deletePath).isDirectory()) {
    fs.rmdirSync(deletePath, {
      recursive: true,
    });
  } else {
    fs.unlinkSync(deletePath);
  }
}
