const { ipcRenderer } = require("electron");

/**
 * @param {string} selector
 * @returns {HTMLElement}
 */
function ensuredQuery(selector) {
    const element = document.querySelector(selector);
    if (!element || !(element instanceof HTMLElement))
        throw new Error(`Could not find element with selector '${selector}'`);
    return element;
}
/** @type {(selector: string) => HTMLInputElement} */
const ensuredInputQuery = (selector) => /** @type {HTMLInputElement} */ (ensuredQuery(selector));
/** @type {(selector: string) => HTMLButtonElement} */
const ensuredButtonQuery = (selector) => /** @type {HTMLButtonElement} */ (ensuredQuery(selector));

const submitButton = ensuredButtonQuery("#submitButton");

ensuredQuery("#configuration").addEventListener("submit", (e) => {
    submitButton.disabled = true;

    e.preventDefault();

    const invalidFields = document.querySelectorAll(".invalid");
    invalidFields.forEach((field) => field.classList.remove("invalid"));

    let address = ensuredInputQuery("#serverAddress").value;
    let username = ensuredInputQuery("#username").value;
    let password = ensuredInputQuery("#password").value;
    let protocol = ensuredInputQuery("#protocol").value;
    let port = ensuredInputQuery("#port").value;

    ipcRenderer.send("ADD_SERVER", {
        address,
        username,
        password,
        port,
        protocol,
    });
});

ipcRenderer.on("RESET", (_, resetFields) => {
    submitButton.disabled = false;

    if (resetFields) {
        ensuredInputQuery("#serverAddress").value = "";
        ensuredInputQuery("#username").value = "";
        ensuredInputQuery("#password").value = "";
        ensuredInputQuery("#port").value = "";
    }
});

ipcRenderer.on(
    "VALIDATION_ERROR",
    /** @param {string[]} data */ (_, data) => {
        submitButton.disabled = false;

        data.forEach((fieldName) => {
            const field = ensuredQuery(`#${fieldName}`);

            field.classList.add("invalid");
        });
    }
);
