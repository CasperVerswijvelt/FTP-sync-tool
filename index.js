const ftp = require("basic-ftp");
const fs = require("fs");
const mkdirp = require("mkdirp");
const chokidar = require('chokidar');

const express = require("express");
const { server } = require("websocket");

const http = require("http")
const path = require('path');

const { exit } = require("process");

// Config variables

let downloadDirectory = "./";
let host = "";
let user = "";
let password = "";
let certPath = ""
let folderSizeDepth = 5;

// Parse config

let config;

try {

  config = JSON.parse(fs.readFileSync("config.json", { encoding: "utf-8" }))

  if (!isNEString(config.host)) throw "Host cannot be empty"

  host = config.host

  if (!isNEString(config.user)) throw "User cannot be empty"

  user = config.user

  if (!isNEString(config.password)) throw "Password cannot be empty"

  password = config.password

  if (!isNEString(config.certificate)) throw "Certificate path cannot be empty"

  certPath = config.certificate

  if (isNEString(config.downloadDirectory)) {

    downloadDirectory = config.downloadDirectory
  }

  if (typeof config.folderSizeDepth === 'number') {

    folderSizeDepth = config.folderSizeDepth;
  }

} catch (e) {

  console.log("Config load error:", e)
  exit(1)
}

downloadDirectory = getCleanPath(downloadDirectory)

// Ftp client

const downloadClient = new ftp.Client();
const accessOptions = {
  host: host,
  user: user,
  password: password,
  secure: true,
  secureOptions: {
    ca: fs.readFileSync(certPath, { encoding: "utf-8" }),
    checkServerIdentity: () => {
      return undefined;
    },
  },
};

const downloadQueue = [];

isDownloadingQueue = false;

// File watching

chokidar.watch(downloadDirectory, {ignoreInitial: true}).on('all', (event, path) => {

  switch(event) {
    case "add":
    case "unlink":
    case "addDir":
    case "unlinkDir":
      connections.forEach(connection => connection.send(JSON.stringify({
        type: "listElement",
        data: {
          path: getCleanPath(path),
          existsLocally: event === "add" || event === "addDir"
        }
      })));
      break;
  }
});

// HTTP Server

const port = process.env.PORT || 3000;
const app = express();
const httpServer = http.createServer(app);
app.use(express.static(__dirname + '/frontend'));
httpServer.listen(port, () => {
  return console.log(`server is listening on ${port}`);
});

// WebSocket

const connections = [];

const wsServer = new server({
  httpServer: httpServer,
  autoAcceptConnections: true,
});

wsServer.on("connect", (connection) => {

  connections.push(connection)

  connection.on("message", (message) => {

    try {
      const msg = JSON.parse(message.utf8Data)

      switch (msg.action) {
        case "list":
          listPath(connection, msg.path)
          break;
        case "delete":
          deletePath(connection, msg.path)
          break;
        case "download":
          addToQueue(connection, msg.path)
          break;
        case "listQueue":
          sendQueueList();
          break;
        case "cancelQueueElement":
          cancelQueueElement(connection, msg.path);
          break;
      }
    } catch (e) { }
  });

  connection.on("close", (reason, description) => {
    const index = connections.indexOf(connection);
    if (index > -1) {
      connections.splice(index, 1);
    }
  })
});

async function listPath(connection, directory) {

  if (!checkPathSafe(directory)) {
    sendError(connection, "Invalid list path")
    return;
  }

  directory = directory ? getCleanPath(directory) : ''

  let list;
  try {
    list = await listFtp(directory.replace(/\\/g, '/'));
  } catch (e) {
    console.error(e);
    sendError("FTP Error: " + e.message)
    return;
  }

  const mappedList = list
    .filter(el => !el.name.startsWith('.'))
    .map((el) => {
      return {
        name: el.name,
        path: getCleanPath(path.join(directory ? directory : '', el.name)),
        existsLocally: fs.existsSync(path.join(downloadDirectory, getCleanPath(path.join(directory ? directory : '', el.name)))),
        type: el.type,
        size: el.size
      }
    });

  connection.send(JSON.stringify({
    type: "list",
    data: (directory === downloadDirectory ? [] : [{
      name: "Parent directory",
      path: path.dirname(directory) ? path.dirname(directory) : '',
      existsLocally: true,
      type: -1
    }])
      .concat(mappedList)
  }));
}

function sendError(connection, error) {

  connection?.send(JSON.stringify({
    type: "error",
    data: error
  }))
}

function sendErrorToAll(error) {

  connections.forEach(connection => connection.send(JSON.stringify({
    type: "error",
    data: error
  })))
}

function deletePath(connection, deletePath) {

  if (!isNEString(deletePath)) {
    sendError(connection, "Delete error: empty delete path");
    return;
  }

  if (!checkPathSafe(deletePath)) {
    sendError(connection, "Delete error: invalid delete path")
    return;
  }

  try {
    fs.rmSync(path.join(downloadDirectory, deletePath), {
      force: true,
      recursive: true,
    })

  } catch (e) {
    console.error(e)
    sendError(connection, e.message)
  }
}

// Download queue

async function addToQueue (connection, addToQueuePath) {

  if (!checkPathSafe(addToQueuePath)) {
    sendError(connection, "Queue add error: invalid download path")
    return;
  }

  const cleanPath = getCleanPath(addToQueuePath);
  const ftpParentPath = path.dirname(cleanPath).replace(/\\/g, '/');
  const ftpBaseName = path.basename(cleanPath);

  if (downloadQueue.find(el => el.path == cleanPath)) {
    sendError(connection, "Queue add error: element already in queue")
    return;
  }

  let file

  try {
    const list = await listFtp(ftpParentPath);
    file = list.find(el => el.name === ftpBaseName);

  } catch (e) {
    console.error(e);
    sendError(connection, "Queue add error: FTP Error - " + e.message)
    return;
  }
  
  if (file) {
    const queueElement = {
      path: getCleanPath(addToQueuePath),
      name: path.basename(getCleanPath(addToQueuePath)),
      type: file?.type,
      size: 0,
      progress: 0,
      isDownloading: false
    };

    downloadQueue.push(queueElement)

    sendQueueList();
    startQueue();

    calculateFTPSize(file, queueElement)
  } else {
    sendError(connection, "Queue add error: could not determine file type")
  }
}

async function calculateFTPSize(file, queueElement) {

  const browseClient = new ftp.Client()
  await browseClient.access(accessOptions);

  let size
  const elPath = queueElement.path.replace(/\\/g, '/');

  try {

    if (file.type === 1) {
      size = await browseClient.size(elPath);
      browseClient.close();
      queueElement.size = size;
      sendQueueElement(queueElement)
    } else if (file.type === 2) {

      const updateSizeIntervalId = setInterval(() => {
        sendQueueElement(queueElement)
      }, 1000)
      
      getFolderSize(elPath, 0, queueElement).then(() => {
        clearInterval(updateSizeIntervalId);
        sendQueueElement(queueElement)
        browseClient.close();
      }).catch((e) => {
        clearInterval(updateSizeIntervalId);
        sendErrorToAll("Queue error: Could not determine queue element size of folder: " + e)
        console.error(e)
      })
    } else {
      sendErrorToAll("Queue error: Could not determine queue element size for non folder and non file type")
    }
  } catch (e) {
    browseClient.close();
    console.error(e);
    sendErrorToAll("Queue error: Could not determine queue element size - " + e.message)
    return;
  }

  async function getFolderSize(folderPath, level, queueElement) {

    let size = 0;

    if (level > folderSizeDepth)
      return 0;

    const list = await browseClient.list(folderPath);

    for (let element of list) {

      const elPath = path.join(folderPath, element.name).replace(/\\/g, '/');

      if (element.type === 1) {
        queueElement.size += element.size;
      } else if (element.type === 2) {
        await getFolderSize(elPath, level + 1, queueElement);
      }
    }
  }
}

function startQueue() {

  if (isDownloadingQueue) return;

  isDownloadingQueue = true;

  return getDownloadNextElementPromise();

  function getDownloadNextElementPromise() {

    const queueElement = downloadQueue [0];

    if (queueElement) {
      queueElement.isDownloading = true;
      sendQueueElement(queueElement);
      return downloadQueueElement(queueElement).then(getDownloadNextElementPromise);
    }

    isDownloadingQueue = false;
    return Promise.resolve();
  }
}

async function downloadQueueElement(queueElement) {

  try {
    const downloadPath = queueElement.path;

    const localPath = path.join(downloadDirectory, downloadPath);
    const localParentPath = path.dirname(localPath);
    const cleanPath = getCleanPath(downloadPath);
    const ftpPath = cleanPath.replace(/\\/g, '/');

    downloadClient.trackProgress((info) => {
      if (info.type === "download") {
        queueElement.progress = info.bytesOverall
        sendQueueElement(queueElement);
      }
    });

    function stopTrackingProgress() {
      downloadClient.trackProgress();
    }

    await connectDownloadClient();
    if (queueElement.type === 2) {
      await downloadClient.downloadToDir(localPath, ftpPath)
      stopTrackingProgress();
    } else if (queueElement.type === 1) {
      await  mkdirp(localParentPath)
      await downloadClient.downloadTo(localPath, ftpPath)
      stopTrackingProgress();
    }
    closeDownloadClient();
    downloadQueue.splice(downloadQueue.indexOf(queueElement), 1)
    sendQueueList();
  } catch (e) {
    downloadQueue.splice(downloadQueue.indexOf(queueElement), 1)
    sendQueueList();
    sendErrorToAll("FTP Download error for '" + queueElement?.path + "': " + e)
    console.error(e);
  }
}

function sendQueueList() {

  connections.forEach(connection => connection.send(JSON.stringify({
    type: "queue",
    data: downloadQueue
  })));
}

function sendQueueElement(queuElement) {

  connections.forEach(connection => connection.send(JSON.stringify({
    type: "queueElement",
    data: queuElement
  })));
}

function cancelQueueElement(connection, cancelPath) {
  const cleanPath = getCleanPath(cancelPath);
  const queueElement = downloadQueue.find(el => el.path === cleanPath);

  if (queueElement) {
    const index = downloadQueue.indexOf(queueElement);

    if (queueElement.isDownloading) {
      sendError(connection, "Queue cancel error: can't cancel downloading item");
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

async function listFtp(listPath) {
  
  const client = new ftp.Client();
  await client.access(accessOptions);
  try {
    return client.list(listPath);
  } catch (e) {
    client.close();
    throw e;
  }
}

// Util

function isNEString(value) {
  return typeof (value) === 'string' && value.length > 0
}

function checkPathSafe(checkPath) {

  const absDownloadPath = path.resolve(downloadDirectory);
  const absCheckPath = path.resolve(checkPath);

  if (absDownloadPath === absCheckPath) return true;

  const relative = path.relative(absDownloadPath, absCheckPath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getCleanPath(uncleanPath) {

  const resolved = path.resolve(uncleanPath);
  const resolvedDownloadPath = path.resolve(downloadDirectory);

  return path.relative(resolvedDownloadPath, resolved);
}
