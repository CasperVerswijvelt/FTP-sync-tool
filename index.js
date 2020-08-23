const ftp = require("basic-ftp");
const fs = require("fs");
const inquirer = require("inquirer");
const cliProgress = require("cli-progress");
const { type } = require("os");

const client = new ftp.Client();
const accessOptions = {
  host: "78.22.145.53",
  user: "robin",
  password: "RobinSuckt123",
  secure: true,
  secureOptions: {
    ca: fs.readFileSync("server-cert.pem", { encoding: "utf-8" }),
    checkServerIdentity: () => {
      return undefined;
    },
  },
};
console.clear();

const foldersToDownload = [];

client
  .access(accessOptions)
  .then(loopPromptMedia)
  .then(downloadMedia)
  .then(closeClient)
  .catch(onError);

function onError(e) {
  console.log("Error:", e);
  return closeClient();
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
    .then(askMediaPreferences)
    .then(searchMedia)
    .then(inquireMedia)
    .then(handleMedia);
}

function getMediaFolders() {
  return client.list();
}

function searchMedia(mediaPref) {
  let path = mediaPref.media_path;
  let name = mediaPref.media_title;

  return client.list(path).then((files) => {
    return {
      path: path,
      files: files.filter((file) =>
        file.name.toLowerCase().includes(name.toLowerCase())
      ),
    };
  });
}

function inquireMedia(filesInfo) {
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
              !foldersToDownload.filter(
                (folder) => folder.file.name === file.name
              ).length
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
    if (files.filter((file) => file.name === "Season 1").length) {
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
  foldersToDownload.forEach((file) => {
    bars[file.file.name] = multibar.create(file.size, 0, {
      media: file.file.name,
      totalFormat: formatBytes(file.size),
      valueFormat: formatBytes(0),
    });
  });

  return getDownloadNextFolderPromise();

  function getDownloadNextFolderPromise() {
    if (currentFolder < foldersToDownload.length) {
      let folderInfo = foldersToDownload[currentFolder++];

      return downloadFolder(folderInfo).then(getDownloadNextFolderPromise);
    }

    multibar.stop();
    return Promise.resolve();
  }

  function downloadFolder(fileInfo) {
    const remotePath = fileInfo.path;
    const localPath = `${__dirname}/${remotePath}`;

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

    return client
      .downloadToDir(localPath, remotePath)
      .then(stopTrackingProgress);
  }
}

function handleSerie(fileInfo, files) {
  // Serie media: handle individual episode download
  return Promise.reject("Serie download not supported yet");
}

function handleMovie(fileInfo, files) {
  // Movie media: download whole folder
  foldersToDownload.push({
    path: fileInfo.path,
    file: fileInfo.file,
    size: files.reduce(function (a, b) {
      return a + b.size;
    }, 0),
  });
}

function askMediaPreferences(files) {
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

function formatBytes(bytes) {
  let decimals = 2;
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
