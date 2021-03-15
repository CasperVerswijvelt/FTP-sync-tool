// Create websocket connection
const ws = new WebSocket(((window.location.protocol === "https:") ? "wss://" : "ws://") + window.location.host + "/ws");

const TYPE_PARENT = -1;
const TYPE_FILE = 1;
const TYPE_FOLDER = 2;

ws.onmessage = (messageEvent) => {
    try {
        const message = JSON.parse(messageEvent.data);

        switch (message.type) {
            case "list":
                loadList(message.data)
                break;
            case "listElement":
                break;
        }
    } catch (e) {
        console.error(e)
    }
}

function listPath(path) {
    ws.send(JSON.stringify({
        action: "list",
        path: path
    }))
}

function downloadPath(path) {
    ws.send(JSON.stringify({
        action: "download",
        path: path
    }))
}

function deletePath(path) {
    ws.send(JSON.stringify({
        action: "delete",
        path: path
    }))
}

function loadList(data) {
    if (!Array.isArray(data)) return;

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
            if (element.existsLocally) 
                deletePath(element.path)
        }

        tr.onclick = () => {
            if (element.type === TYPE_FOLDER || element.type === TYPE_PARENT)
                listPath(element.path)
        }

        body.appendChild(tr)
    }
}