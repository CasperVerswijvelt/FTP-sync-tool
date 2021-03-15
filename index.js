const ftp = require("basic-ftp");
const fs = require("fs");
const mkdirp = require("mkdirp");

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

} catch(e) {

  console.log("Config load error:", e)
  exit(1)
}

// Ftp client

const client = new ftp.Client();
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

// HTTP Server

const port = process.env.PORT || 3000;
const app = express();
const httpServer = http.createServer(app);
app.use(express.static( __dirname + '/frontend' ));
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

  sendOverview(connection, downloadDirectory)

  connection.on("message", (message) => {
  
    try {
      const msg = JSON.parse(message.utf8Data)

      switch(msg.action) {
        case "list":
          sendOverview(connection, msg.path)
          break;
        case "delete":
          deletePath(connection, msg.path)
          break;
        case "download":
          addToQueue(connection, "not yet implemented")
          break;
        case "cancelDownload":
          sendError(connection, "not yet implemented")
          break;
      }
    } catch (e) {}
  });

  connection.on("close", (reason, description) => {
    const index = connections.indexOf(connection);
    if (index > -1) {
      connections.splice(index, 1);
    }
  })
});

async function sendOverview(connection, directory) {

  await connect();

  const list = await client.list(directory);

  for (let el of list) {
    el.path = isNEString(directory) ? directory + "/" + el.name : el.name;
    el.existsLocally = fs.existsSync(path.join(downloadDirectory, el.path));
  }

  connection.send(JSON.stringify({
    type: "list",
    data: (directory === downloadDirectory ? [] : [{
      name: "Parent diretory",
        path: path.dirname(directory),
        existsLocally: true,
        type: -1
    }])
      .concat(list
        .filter(el => !el.name.startsWith('.'))
        .map((el) => {
          return {
            name: el.name,
            path: isNEString(directory) ? directory + "/" + el.name : el.name,
            existsLocally: fs.existsSync(path.join(downloadDirectory, el.path)),
            type: el.type
          }
        })
      )
    }))

  closeClient();
}

function sendError(connection, error) {

  connection.send(JSON.stringify({
    type: "error",
    data: error
  }))
}

function deletePath(connection, deletePath) {

  try {
    if (isNEString(deletePath)) {
      fs.rmSync(path.join(downloadDirectory, deletePath), {
        force: true,
        recursive: true,
      })
  
      connection.send(JSON.stringify({
        type: "listElement",
        data: {
          path: deletePath,
          existsLocally: false
        }
      }))
    } else {
      sendError(connection, "Empty delete path")
    }
  } catch(e) {

    console.log(e)

    // TODO: log error
    sendError(connection, e.message)
  }
}

function addToQueue(downloadPath) {

  downloadQueue.push({
    path: downloadPath,
    progress: 0
  });

  downloadMedia()
}

// loadConfig()
//   .catch(doNothingLmao)
//   .then(connect)
//   .then(loopPromptMedia)
//   .then(promptDownloadDirectory)
//   .then(downloadMedia)
//   .then(closeClient)
//   .catch(onError);

function onError(e) {
  console.log("Error:", e);
  return closeClient();
}

function connect() {
  return client.access(accessOptions);
}

function doNothingLmao() {
  // Does nothing xpxppx
}

function loadConfig() {
  return new Promise((resolve, reject) => {
    fs.readFile("config.json", function read(err, data) {
      if (err) {
        reject(err);
      }

      let config;
      try {
        config = JSON.parse(data);

        if (config.downloadDirectory) {
          downloadDirectory = config.downloadDirectory;
        }
      } catch (e) {
        reject(err);
      }
      resolve(config);
    });
  });
}

function promptDownloadDirectory() {
  return inquirer
    .prompt([
      {
        type: "input",
        message: `Current download directory is '${downloadDirectory}' Do you want to change it? (Just enter to skip)`,
        name: "dir",
      },
    ])
    .then((answers) => {
      let dir = answers.dir;
      if (dir && dir.length > 0) downloadDirectory = dir;
    });
}

function loopPromptMedia() {
  return promptMedia()
    .then(promptDownloadMoreMedia)
    .then((result) => {
      if (result) return loopPromptMedia();
      return Promise.resolve();
    });

  function promptDownloadMoreMedia() {
    return inquirer
      .prompt([
        {
          type: "confirm",
          message: "Download more media?",
          name: "result",
        },
      ])
      .then((answers) => {
        return !!answers.result;
      });
  }
}

function promptMedia() {
  return getMediaFolders()
    .then(askMediaTypeAndSearchTerm)
    .then(searchMedia)
    .then(askMediaSelect)
    .then(handleMedia)
    .catch((e) => console.log(e));
}

function getMediaFolders() {
  return client.list();
}

function searchMedia(mediaPref) {
  let path = mediaPref.media_path;
  let name = mediaPref.media_title;

  return client.list(path).then((files) => {
    let filteredFiles = files.filter((file) =>
      file.name.toLowerCase().includes(name.toLowerCase())
    );

    if (filteredFiles.length) {
      return {
        path: path,
        files: filteredFiles,
      };
    }

    return Promise.reject("No search results");
  });
}

function askMediaSelect(filesInfo) {
  return inquirer
    .prompt([
      {
        type: "list",
        message: "Pick your media",
        name: "name",
        choices: filesInfo.files
          .filter(
            (file) =>
              file.isDirectory &&
              !file.name.startsWith(".") &&
              !downloadQueue.filter((folder) => folder.file.name === file.name)
                .length
          )
          .map((file) => file.name),
      },
    ])
    .then((answers) => {
      let file = filesInfo.files.filter(
        (file) => file.name === answers.name
      )[0];
      return {
        path: `${filesInfo.path}/${file.name}`,
        file: file,
      };
    });
}

function handleMedia(fileInfo) {
  return client.list(fileInfo.path).then((files) => {
    if (files.filter((file) => file.name.match(/Season [0-9]+/)).length) {
      return handleSerie(fileInfo, files);
    } else {
      return handleMovie(fileInfo, files);
    }
  });
}

function downloadMedia() {
  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format:
        "{bar} {percentage}% | {media} | ETA: {eta}s | {valueFormat} / {totalFormat}",
    },
    cliProgress.Presets.shades_grey
  );

  let currentFolder = 0;
  let bars = {};
  downloadQueue.forEach((file) => {
    bars[file.file.name] = multibar.create(file.size, 0, {
      media: file.file.name,
      totalFormat: formatBytes(file.size),
      valueFormat: formatBytes(0),
    });
  });

  return getDownloadNextElementPromise();

  function getDownloadNextElementPromise() {
    if (currentFolder < downloadQueue.length) {
      let folderInfo = downloadQueue[currentFolder++];

      return downloadElement(folderInfo).then(getDownloadNextElementPromise);
    }

    multibar.stop();
    return Promise.resolve();
  }

  function downloadElement(fileInfo) {
    const remotePath = fileInfo.path;
    const localPath = `${downloadDirectory}${remotePath}`;
    const localParentPath = `${downloadDirectory}${fileInfo.parentPath}`;

    client.trackProgress((info) => {
      bar = bars[fileInfo.file.name];
      if (bar && info.type === "download")
        bar.update(info.bytesOverall, {
          valueFormat: formatBytes(info.bytesOverall),
        });
    });

    function stopTrackingProgress() {
      client.trackProgress();
    }

    if (fileInfo.type === "folder") {
      return client
        .downloadToDir(localPath, remotePath)
        .then(stopTrackingProgress);
    } else if (fileInfo.type === "file") {
      return mkdirp(localParentPath).then(() => {
        return client
          .downloadTo(localPath, remotePath)
          .then(stopTrackingProgress);
      });
    }
  }
}

function handleSerie(fileInfo, files) {
  // Serie media: handle individual episode download
  let seasonPath;
  let episodeFiles;

  return askSeason().then(getSeasonEpisodes).then(askEpisodeSelect);

  function askSeason() {
    return inquirer
      .prompt([
        {
          type: "list",
          message: "What season?",
          name: "season",
          choices: files
            .filter((file) => file.isDirectory && !file.name.startsWith("."))
            .map((file) => file.name),
        },
      ])
      .then((answers) => {
        seasonPath = `${fileInfo.path}/${answers.season}`;
        return seasonPath;
      });
  }

  function getSeasonEpisodes(path) {
    return client.list(path).then((files) => (episodeFiles = files));
  }

  function askEpisodeSelect() {
    return inquirer
      .prompt([
        {
          type: "checkbox",
          message: "Which episodes do you want to download?",
          name: "episodes",
          choices: episodeFiles
            .filter((file) => !file.isDirectory && !file.name.startsWith("."))
            .map((file) => file.name),
        },
      ])
      .then((answers) => {
        answers.episodes.forEach((episode) => {
          let episodeFile = episodeFiles.filter(
            (file) => file.name === episode
          )[0];
          downloadQueue.push({
            type: "file",
            path: `${seasonPath}/${episode}`,
            parentPath: seasonPath,
            file: episodeFile,
            size: episodeFile.size,
          });
        });
      });
  }
}

function handleMovie(fileInfo, files) {
  // Movie media: download whole folder
  downloadQueue.push({
    type: "folder",
    path: fileInfo.path,
    file: fileInfo.file,
    size: files.reduce(function (a, b) {
      return a + b.size;
    }, 0),
  });
}

function askMediaTypeAndSearchTerm(files) {
  return inquirer.prompt([
    {
      type: "list",
      message: "What media?",
      name: "media_path",
      choices: files
        .filter((file) => file.isDirectory && !file.name.startsWith("."))
        .map((file) => file.name),
    },
    {
      type: "input",
      message: "Title?",
      name: "media_title",
    },
  ]);
}

function closeClient() {
  return client.close();
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
  return typeof(value) === 'string' && value.length > 0
}
