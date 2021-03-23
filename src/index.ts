// Imports

// FTP
import { Client, FileInfo, AccessOptions, FileType } from "basic-ftp";

// Filesystem
import fs from "fs";
import mkdirp from "mkdirp";
import chokidar from "chokidar";
import path from "path";

// Server
import express from "express";
import ws from "ws";
import http from "http";

// Types and constants
import { QueueElement } from "./models/QueueElement";
import { ActionType } from "./models/ActionType";
import { MessageType } from "./models/MessageType";

import { exit } from "process";
import { Config } from "./models/Config";
import { ActionMessage } from "./models/ActionMessage";
import { Response } from "./models/Response";
import { ErrorType } from "./models/Error";

// Config variables

let downloadDirectory = "./";
let folderSizeDepth = 5;

// FTP client and access options

const downloadClient = new Client();
let accessOptions: AccessOptions;

// Parse config

let config: Config;

try {
  config = JSON.parse(fs.readFileSync("config.json", { encoding: "utf-8" }));

  const ftp = config.ftp;

  if (!ftp) throw "ftp is a required config field";

  // Host: required

  if (!isNEString(ftp.host)) throw "Host cannot be empty";

  // Create access options

  accessOptions = {
    host: ftp.host,
    user: isNEString(ftp.user) ? ftp.user : undefined,
    password: isNEString(ftp.password) ? ftp.password : undefined,
    secure: typeof ftp.secure === "boolean" || ftp.secure === "implicit" ? ftp.secure : undefined,
    secureOptions: {},
  };

  // Certificate: optional [none]
  if (isNEString(ftp.certificate)) {
    accessOptions.secureOptions.ca = fs.readFileSync(ftp.certificate, { encoding: "utf-8" });
  }

  // Check server identity: optional [true]
  if (ftp.checkServerIdentity === false) {
    accessOptions.secureOptions.checkServerIdentity = (): Error => {
      return null;
    };
  }

  // Local downloaddiretory: optional ['./']
  if (isNEString(config.downloadDirectory)) {
    downloadDirectory = config.downloadDirectory;
  }

  // Folder size depth: optional [5]
  if (typeof config.folderSizeDepth === "number") {
    folderSizeDepth = config.folderSizeDepth;
  }
} catch (e) {
  console.error("Config load error:", e);
  exit(1);
}

downloadDirectory = path.resolve(downloadDirectory);

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

// Queue

const downloadQueue: QueueElement[] = [];
let isDownloadingQueue = false;

// WebSocket

const connections: ws[] = [];

const wss = new ws.Server({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  if (!isNEString(config.security?.websocketOrigin) || req.headers.origin?.startsWith(config.security?.websocketOrigin)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.log(`Denying connection from ${req.connection.remoteAddress} at origin ${req.headers.origin}`);
    socket.destroy();
  }
});

wss.on("connection", (ws: ws) => {

  connections.push(ws);

  ws.send(JSON.stringify({
    type: MessageType.QUEUE,
    data: downloadQueue
  }))

  ws.on("message", (data: ws.Data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.action) {
        case ActionType.LIST:
          onList(ws, msg);
          break;
        case ActionType.DELETE:
          onDelete(ws, msg);
          break;
        case ActionType.QUEUE_ADD:
          onQueueAdd(ws, msg);
          break;
        case ActionType.QUEUE_REMOVE:
          onQueueRemove(ws, msg);
          break;
      }
    } catch (e) {
      // Do nothing
    }
  });

  ws.on("close", (ws: ws) => {
    const index = connections.indexOf(ws);
    if (index > -1) {
      connections.splice(index, 1);
    }
  });
});

// WebSocket helper functions

function sendResponse(connection: ws, response: Response) {
  connection?.send(JSON.stringify(response));
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

// WebSocket message handlers

async function onList(connection: ws, message: ActionMessage) {
  if (!isString(message.data?.path)) {
    sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        subType: ErrorType.INVALID_ARGUMENT_TYPE,
        reason: "Path should be of type string",
      },
    });
    return;
  }

  let directory = message.data?.path as string;

  if (!checkSafePath(directory)) {
    sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        reason: "Path is not valid",
      },
    });
    return;
  }

  directory = directory ? getCleanPath(directory) : "";

  let list;
  try {
    list = await listFtp(directory.replace(/\\/g, "/"));
  } catch (e) {
    console.error(e);
    sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.FTP_ERROR,
        reason: e.message,
      },
    });
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

  const resultList = (!checkLocalPathSafe(path.dirname(path.resolve(path.join(downloadDirectory, directory))))
    ? []
    : [
        {
          name: "Parent directory",
          path: path.dirname(directory) ? path.dirname(directory) : "",
          existsLocally: true,
          type: -1,
        },
      ]
  ).concat(mappedList);

  sendResponse(connection, {
    id: message.id,
    success: true,
    data: resultList,
  });
}

function onDelete(connection: ws, message: ActionMessage) {

  if (!isString(message.data?.path)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        subType: ErrorType.INVALID_ARGUMENT_TYPE,
        reason: "Path should be of type string",
      },
    });
  }

  const deletePath = message.data?.path as string;
  const cleanPath = getCleanPath(deletePath);

  if (!checkSafePath(deletePath)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        reason: "Path is invalid",
      },
    });
  }

  const actualDeletePath = path.join(downloadDirectory, cleanPath);

  try {
    rmSync(actualDeletePath);
    return sendResponse(connection, {
      id: message.id,
      success: true
    })
  } catch (e) {
    console.error(e);
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.DELETE_ERROR,
        reason: e.message,
      },
    });
  }
}

async function onQueueAdd(connection: ws, message: ActionMessage) {

  if (!isString(message.data?.path)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        subType: ErrorType.INVALID_ARGUMENT_TYPE,
        reason: "Path should be of type string",
      },
    });
  }

  const addToQueuePath = message.data?.path as string

  if (!checkSafePath(addToQueuePath)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        reason: "Path is invalid",
      },
    });
  }

  const cleanPath = getCleanPath(addToQueuePath);
  const ftpParentPath = path.dirname(cleanPath).replace(/\\/g, "/");
  const ftpBaseName = path.basename(cleanPath);

  if (downloadQueue.find((el) => el.path == cleanPath)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.QUEUE_ERROR,
        subType: ErrorType.QUEUE_ALREADY_ADDED,
        reason: "Element is already in queue",
      },
    });
  }

  let file: FileInfo;

  try {
    const list = await listFtp(ftpParentPath);
    file = list.find((el) => el.name === ftpBaseName);
  } catch (e) {
    console.error(e);
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.QUEUE_ERROR,
        reason: "Could not get file details",
      },
    });
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

    sendResponse(connection, {
      id: message.id,
      success: true,
      data: queueElement
    });
    sendQueueList();

    startQueue();
    calculateFTPSize(file, queueElement);

  } else {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.QUEUE_ERROR,
        reason: "Could not get determine file type",
      },
    });
  }
}

function onQueueRemove(connection: ws, message: ActionMessage) {

  if (!isString(message.data?.path)) {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        subType: ErrorType.INVALID_ARGUMENT_TYPE,
        reason: "Path should be of type string",
      },
    });
  }

  const cancelPath = message.data?.path as string

  const cleanPath = getCleanPath(cancelPath);
  const index = downloadQueue.findIndex((el) => el.path === cleanPath);
  const queueElement = downloadQueue[index];

  if (queueElement) {

    if (queueElement.isDownloading) {
      queueElement.isCancelled = true;
      if (!downloadClient.closed) downloadClient.close();
      // Queue element gets remove when download fails due to client being closed
    } else {
      downloadQueue.splice(index, 1);
    }

    return sendResponse(connection, {
      id: message.id,
      success: true,
      data: downloadQueue.splice(index, 1)[0]
    });

  } else {
    return sendResponse(connection, {
      id: message.id,
      success: false,
      error: {
        type: ErrorType.INVALID_ARGUMENT,
        reason: "Element not in queue",
      },
    });
  }
}

// Queue handling

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
    sendToAll(JSON.stringify({
      type: MessageType.DOWNLOAD_COMPLETE,
      data: queueElement
    }));
  } catch (e) {
    downloadQueue.splice(downloadQueue.indexOf(queueElement), 1);
    sendQueueList();

    if (!queueElement.isCancelled) {
      sendToAll(JSON.stringify({
        type: MessageType.DOWNLOAD_ERROR,
        data: {
          reason: e.message
        }
      }));
      console.error(e);
    } else {
      try {
        rmSync(localPath);
      } catch (e) {
        sendToAll(JSON.stringify({
          type: MessageType.QUEUE_CANCEL_ERROR,
          data: {
            type: MessageType.QUEUE_CANCEL_REMNANTS_REMOVE_ERROR,
            reason: e.message,
            queueElement: queueElement
          }
        }))
      }
    }
  }
}

// FTP helper functions

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
          sendToAll(JSON.stringify({
            type: MessageType.QUEUE_ELEMENT_SIZE_ERROR,
            data: {
              queueElement: queueElement,
              reason: e.message
            }
          }))
          console.error(e);
        });
    } else {
      sendToAll(JSON.stringify({
        type: MessageType.QUEUE_ELEMENT_SIZE_ERROR,
        data: {
          queueElement: queueElement,
          reason: "Element is nor a folder nor a file?"
        }
      }))
    }
  } catch (e) {
    browseClient.close();
    console.error(e);
    return sendToAll(JSON.stringify({
      type: MessageType.QUEUE_ELEMENT_SIZE_ERROR,
      data: {
        queueElement: queueElement,
        reason: e.message
      }
    }))
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

// Util

function isString(value: unknown) {
  return typeof value === "string";
}

function isNEString(value: unknown) {
  return isString(value) && (value as string).length > 0;
}

function checkSafePath(checkPath: string) {
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
