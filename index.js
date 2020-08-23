const ftp = require("basic-ftp");
const fs = require("fs");
const inquirer = require("inquirer");
const cliProgress = require("cli-progress");

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

client
  .access(accessOptions)
  .then(getMediaFolders)
  .then(askMediaPreferences)
  .then(searchMedia)
  .then(askMedia)
  .then(handleMedia)
  .then(closeClient)
  .catch(function (e) {
    console.log(e);
    closeClient();
  });

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

function askMedia(filesInfo) {
  return inquirer
    .prompt([
      {
        type: "list",
        message: "Pick your media",
        name: "name",
        choices: filesInfo.files
          .filter((file) => file.isDirectory && !file.name.startsWith("."))
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

function handleSerie(fileInfo, files) {
  // Serie media: handle individual episode download
  return Promise.reject("Serie download not supported yet");
}

function handleMovie(fileInfo, files) {
  // Movie media: download whole folder
  const remotePath = fileInfo.path;
  const localPath = `${__dirname}/${remotePath}`;

  console.log(`Downloading from ${remotePath} to ${localPath}`);

  const multibar = new cliProgress.MultiBar(
    {
      clearOnComplete: false,
      hideCursor: true,
      format: "{bar} {percentage}% | ETA: {eta}s | {value}/{total}",
    },
    cliProgress.Presets.shades_grey
  );

  bars = {};
  files.forEach((file) => (bars[file.name] = multibar.create(file.size, 0)));
  client.trackProgress((info) => {
    //console.log(info);
    bar = bars[info.name];
    //console.log(info.name, Object.keys(bars));
    if (bar) bar.update(info.bytes);
  });
  return client.downloadToDir(localPath, remotePath).then(client.trackProgress);
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
  client.close();
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
