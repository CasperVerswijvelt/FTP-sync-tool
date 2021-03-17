const ftp = require("basic-ftp");
const fs = require("fs");
const mkdirp = require("mkdirp");
const chokidar = require('chokidar');

const express = require("express");
const { server } = require("websocket");

const http = require("http")
const path = require('path');

const inquirer = require("inquirer");
const cliProgress = require("cli-progress");

const { exit } = require("process");

// Config variables

let downloadDirectory = "./";
let host = "";
let user = "";
let password = "";
let certPath = ""

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

} catch (e) {

  console.log("Config load error:", e)
  exit(1)
}

downloadDirectory = getCleanPath(downloadDirectory)

// Ftp client

const browseClient = new ftp.Client();
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
          addToQueue(msg.path)
          break;
        case "listQueue":
          sendQueueList();
          break;
        case "cancelDownload":
          sendError(connection, "not yet implemented")
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

  await connectBrowseClient();
  const list = await browseClient.list(directory.replace(/\\/g, '/'));
  closeBrowseClient();

  const mappedList = list
    .filter(el => !el.name.startsWith('.'))
    .map((el) => {
      return {
        name: el.name,
        path: getCleanPath(path.join(directory ? directory : '', el.name)),
        existsLocally: fs.existsSync(path.join(downloadDirectory, getCleanPath(path.join(directory ? directory : '', el.name)))),
        type: el.type
      }
    })

  connection.send(JSON.stringify({
    type: "list",
    data: (directory === downloadDirectory ? [] : [{
      name: "Parent diretory",
      path: path.dirname(directory) ? path.dirname(directory) : '',
      existsLocally: true,
      type: -1
    }])
      .concat(mappedList)
  }))

  await closeBrowseClient();
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

  connection?.send(JSON.stringify({
    type: "error",
    data: error
  }))
}

function deletePath(connection, deletePath) {

  if (!isNEString(deletePath)) {
    sendError(connection, "Empty delete path");
    return;
  }

  if (!checkPathSafe(deletePath)) {
    sendError(connection, "Invalid delete path")
    return;
  }

  try {
    fs.rmSync(path.join(downloadDirectory, deletePath), {
      force: true,
      recursive: true,
    })

  } catch (e) {

    console.log(e)

    // TODO: log error
    sendError(connection, e.message)
  }
}

async function addToQueue (addToQueuePath) {

  if (!checkPathSafe(addToQueuePath)) {
    sendError(connection, "Invalid download path")
    return;
  }

  const cleanPath = getCleanPath(addToQueuePath);
  const ftpParentPath = path.dirname(cleanPath).replace(/\\/g, '/');
  const ftpBaseName = path.basename(cleanPath);
  const ftpPath = cleanPath.replace(/\\/g, '/');

  await connectBrowseClient();

  const list = await browseClient.list(ftpParentPath);
  const file = list.find(el => el.name === ftpBaseName);
  const size = await browseClient.size(ftpPath).catch(() => 0)

  closeBrowseClient();
  
  if (file) {
    const queueElement = {
      path: getCleanPath(addToQueuePath),
      name: path.basename(getCleanPath(addToQueuePath)),
      fileType: file?.type,
      size: size,
      progress: 0
    };
    queueElement.progressUi = formatBytes(queueElement.progress)
    queueElement.sizeUi = formatBytes(queueElement.size)
    downloadQueue.push(queueElement)
    sendQueueList();

    startQueue();
  } 
}

function startQueue() {

  if (isDownloadingQueue) return;

  isDownloadingQueue = true;

  return getDownloadNextElementPromise();

  function getDownloadNextElementPromise() {

    const queueElement = downloadQueue [0];

    if (queueElement) {
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

        queueElement.progressUi = formatBytes(queueElement.progress)
        queueElement.sizeUi = formatBytes(queueElement.size)
        sendQueueElement(queueElement);
      }
    });

    function stopTrackingProgress() {
      downloadClient.trackProgress();
    }

    await connectDownloadClient();
    if (queueElement.fileType === 2) {
      await downloadClient.downloadToDir(localPath, ftpPath)
      stopTrackingProgress();
    } else if (queueElement.fileType === 1) {
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
    connections.forEach(connection => sendError(connection, "Error downloading " + queueElement?.path))
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

// FTP client actions

function connectBrowseClient() {
  return browseClient.access(accessOptions);
}

function closeBrowseClient() {
  browseClient.close();
}

function connectDownloadClient() {
  return downloadClient.access(accessOptions);
}

function closeDownloadClient() {
  return downloadClient.close();
}



// Util

function formatBytes(bytes) {
  let decimals = 2;
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

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
