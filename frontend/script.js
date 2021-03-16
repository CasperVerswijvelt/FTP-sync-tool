// Create websocket connection
let ws;

const TYPE_PARENT = -1;
const TYPE_FILE = 1;
const TYPE_FOLDER = 2;

let currentList;
let currentQueue;

connectWebSocket();

function connectWebSocket() {
    ws = new WebSocket(((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + "/ws");

    ws.onmessage = (messageEvent) => {
        try {
            const message = JSON.parse(messageEvent.data);
    
            switch (message.type) {
                case "list":
                    loadList(message.data)
                    break;
                case "listElement":
                    loadListElement(message.data)
                    break;
                case "queue":
                    loadQueue(message.data)
                    break;
                case "queueElement":
                    loadQueueElement(message.data)
                    break;
                case "error":
                    showError(message.data)
                    break;
            }
        } catch (e) {
            console.error(e)
        }
    }

    ws.onclose = (e) => {
        ws = null;
        console.log('WebSocket connection closed. Reconnecting in 1 second...', e.reason);
        setTimeout(connectWebSocket, 1000);
    }

    ws.onerror = (err) => {
        console.log('WebSocket connection error:', err);
        ws.close();
    }

    ws.onopen = () => {
        console.log('Connected to WebSocket');
        if (!currentList) listPath('')
        if (!currentQueue) listQueue()
    }
}

function listPath(path) {
    if(!ws) return;
    ws.send(JSON.stringify({
        action: "list",
        path: path
    }))
}

function listQueue() {
    ws.send(JSON.stringify({
        action: "listQueue"
    }))
}

function downloadPath(path) {
    if(!ws) return;
    ws.send(JSON.stringify({
        action: "download",
        path: path
    }))
}

function deletePath(path) {
    if(!ws) return;
    ws.send(JSON.stringify({
        action: "delete",
        path: path
    }))
}

function loadList(data) {
    if (!Array.isArray(data)) return;

    currentList = data

    const body = document.getElementById("explorer-body");

    if (!body) return;

    while(body.firstChild) body.removeChild(body.firstChild);

    for (let element of data) {

        const tr = document.createElement("tr");

        const exists = document.createElement("td");
        const type = document.createElement("td");
        const name = document.createElement("td");
        const deleteAction = document.createElement("td");
        const downloadAction = document.createElement("td");

        exists.textContent = element.existsLocally ? "✅" : "❌";
        type.textContent = element.type === TYPE_FILE ? "📄" : element.type === TYPE_FOLDER ? "📁" : element.type === TYPE_PARENT ? "⬆️" : "❓";
        name.textContent = element.name;
        name.title = element.path
        deleteAction.textContent = "🗑️";
        downloadAction.textContent = "💾"

        tr.classList.add("cursor")

        tr.appendChild(exists)
        tr.appendChild(type)
        tr.appendChild(name)
        if (element.type !== TYPE_PARENT) tr.appendChild(element.existsLocally ? deleteAction : downloadAction);

        downloadAction.onclick = (event) => {
            event.stopPropagation();
            if (!element.existsLocally) 
                downloadPath(element.path)
        }

        deleteAction.onclick = (event) => {
            event.stopPropagation();
            if (element.existsLocally) {
                if (confirm(`Are you sure you want to delete '${element.path}'?`)) {
                    deletePath(element.path)
                }
            }
        }

        tr.onclick = () => {
            if (element.type === TYPE_FOLDER || element.type === TYPE_PARENT)
                listPath(element.path)
        }

        body.appendChild(tr)
    }
}

function loadListElement(data) {

    if (!data || !Array.isArray(currentList)) return;

    for (let element of currentList) {
        if (element.path === data.path) {
            element.existsLocally = data.existsLocally
        }
    }

    loadList(currentList);
}

function loadQueue(data) {
    if (!Array.isArray(data)) return;

    currentQueue = data

    const body = document.getElementById("queue");

    console.log(body)

    if (!body) return;

    while(body.firstChild) body.removeChild(body.firstChild);

    for (let element of data) {

        const ul = document.createElement("ul");
        ul.innerText = `${element.name}: ${element.progressUi}/${element.sizeUi}`;
        ul.title = element.path;

        body.appendChild(ul)
    }
}

function loadQueueElement(data) {

    if (!data || !Array.isArray(currentQueue)) return;

    for (let element of currentQueue) {
        if (element.path === data.path) {
            element.progress = data.progress;
            element.progressUi = data.progressUi;
        }
    }

    loadQueue(currentQueue);
}

function showError(data) {

    if (!data) return;

    const oldError = document.getElementById("error");

    if (oldError) document.body.removeChild(oldError)

    const errorEl = document.createElement("div");
    errorEl.id = "error";
    
    const date = new Date();
    errorEl.textContent = `${date.getHours()}:${date.getMinutes()}:${date.getSeconds()} - ${data}`;

    document.body.appendChild(errorEl)

}