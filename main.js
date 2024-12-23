const { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog, Notification } = require("electron");
const crypto = require("crypto");
const dedent = require("dedent-js");
const fs = require("fs");
const os = require("os");
const unhandled = require("electron-unhandled");
const contextMenu = require("electron-context-menu");
const { is, chromeVersion, electronVersion, openNewGitHubIssue } = require("electron-util");
const path = require("path");
const { v4 } = require("uuid");
const Store = require("electron-store");
const keytar = require("keytar");
const JFClient = require("./utils/JFClient");
globalThis.ReadableStream = require('readable-stream-polyfill').ReadableStream;
const DiscordRPC = require("@xhayper/discord-rpc");
const Logger = require("./utils/logger");
const { scrubObject, booleanToYN } = require("./utils/helpers");
const { version, name } = require("./package.json");
const {
    clientId,
    iconUrl,
    logRetentionCount,
    discordConnectRetryMS,
    JFConnectRetryMS,
    presenceUpdateIntervalMS,
    maximumSessionInactivity,
    maxLogFileSizeMB,
} = require("./config.json");

/**
 * @type {BrowserWindow}
 */
let mainWindow;

/**
 * @type {Tray}
 */
let tray;

/**
 * @type {JFClient|null}
 */
let jfc;

/**
 * @type {DiscordRPC.Client|null}
 */
let rpc;

let presenceUpdate;
let connectRPCTimeout;

/**
 * @typedef Server
 * @property {string} address
 * @property {string} username
 * @property {string} password
 * @property {string} port
 * @property {string} protocol
 * @property {boolean} isSelected
 * @property {string} serverId
 * @property {string} serverName
 */

(async () => {
    const oldConfigFile = path.join(app.getPath("userData"), "config.json");
    if (fs.existsSync(oldConfigFile)) fs.unlinkSync(oldConfigFile); // For security reasons we will delete the old config file as the new one will be encrypted, this one may contain sensitive information

    let encryptionKey = await keytar.getPassword(name, "dpkey");
    if (!encryptionKey) {
        encryptionKey = crypto.randomBytes(32).toString("hex");
        await keytar.setPassword(name, "dpkey", encryptionKey);
    }

    const store = new Store({
        encryptionKey,
        name: "settings",
        schema: {
            enableDebugLogging: {
                type: "boolean",
                default: false,
            },
            isConfigured: {
                type: "boolean",
                default: false,
            },
            showExternalButtons: {
                type: "boolean",
                default: false,
            },
            UUID: {
                type: "string",
                default: v4(),
            },
            doDisplayStatus: {
                type: "boolean",
                default: true,
            },
            servers: {
                type: "array",
                default: [],
            },
        },
    });

    const logger = new Logger(
        is.development ? "console" : "file",
        path.join(app.getPath("userData"), "logs"),
        logRetentionCount,
        name,
        maxLogFileSizeMB,
        /** @type {boolean} */ (store.get("enableDebugLogging"))
    );

    const debugInfo = () => {
        return dedent`DEBUG INFO:
			Development Mode: ${is.development}
			Platform: ${process.platform} (Version ${os.release()})
			Architecture: ${process.arch}
			JFCord version: ${version}
			Node version: ${process.versions.node}
			Electron version: ${electronVersion}
			Chrome version: ${chromeVersion}
			`;
    };

    logger.info("Starting app...");
    logger.info(debugInfo());

    contextMenu({
        showLookUpSelection: false,
        showSearchWithGoogle: false,
    });

    unhandled({
        logger: (error) => logger.error(error),
        showDialog: true,
        reportButton: (error) => {
            openNewGitHubIssue({
                user: "Chicken",
                repo: "JFCord",
                labels: ["bug"],
                body: `\`\`\`\n${error.stack}\n\`\`\`\n\n---\n\n${debugInfo()}`,
            });
        },
    });

    const startApp = () => {
        mainWindow = new BrowserWindow({
            width: 480,
            height: 310,
            minimizable: false,
            maximizable: false,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false,
            },
            resizable: false,
            title: name,
            show: false,
        });

        // only allow one instance
        const lockedInstance = app.requestSingleInstanceLock();
        if (!lockedInstance) return app.quit();

        // in development mode we allow resizing
        if (is.development) {
            mainWindow.resizable = true;
            mainWindow.maximizable = true;
            mainWindow.minimizable = true;
        } else {
            mainWindow.setMenu(null);
        }

        app.setAppUserModelId(name);

        if (store.get("isConfigured")) {
            startPresenceUpdater();
            moveToTray();
        } else {
            loadWindow("configure", { x: 600, y: 300 }, false);
        }
    };

    const getSelectedServer = () => /** @type {Server[]} */ (store.get("servers")).find((server) => server.isSelected);

    const resetApp = () => {
        store.clear();

        stopPresenceUpdater();

        tray.destroy();

        loadWindow("configure", { x: 600, y: 300 }, false);
    };

    const toggleDisplay = async () => {
        store.set("doDisplayStatus", !store.get("doDisplayStatus"));

        const doDisplay = store.get("doDisplayStatus");

        logger.debug(`doDisplayStatus: ${doDisplay}`);
        if (!doDisplay && rpc) await rpc.user?.clearActivity();
    };

    /**
     * @param {boolean} doHide
     */
    const appBarHide = (doHide) => {
        if (doHide) {
            mainWindow.hide();
            if (process.platform === "darwin") app.dock.hide();
        } else {
            mainWindow.show();
            if (process.platform === "darwin") app.dock.show();
        }

        mainWindow.setSkipTaskbar(doHide);
    };

    /**
     * @param {string} pageName
     * @param {{x: number, y: number}} size
     * @param {boolean} [preventAppQuitOnClose=true]
     */
    const loadWindow = (pageName, size, preventAppQuitOnClose = true) => {
        mainWindow.setSize(size.x, size.y);
        mainWindow.loadFile(path.join(__dirname, "static", `${pageName}.html`));

        if (preventAppQuitOnClose) {
            let closeNoExit;
            mainWindow.addListener(
                "close",
                (closeNoExit = /** @param {Event} e */ (e) => {
                    e.preventDefault(); // prevent app close
                    mainWindow.hide(); // hide window
                    appBarHide(true);
                    mainWindow.removeListener("close", closeNoExit); // remove listener
                })
            );
        }

        appBarHide(false);
    };

    const stopPresenceUpdater = async () => {
        if (jfc) {
            await jfc.logout();
            jfc = null;
        }
        clearInterval(presenceUpdate);
        presenceUpdate = null;
    };

    /**
     * @param {Server} server
     * @returns {void}
     */
    const addServer = (server) => {
        if (!tray) return logger.warn("Attempted to add server without tray");

        const servers = /** @type {Server[]} */ (store.get("servers"));
        servers.push(server);

        store.set("servers", servers);

        tray.setContextMenu(buildTrayMenu(servers));
    };

    /**
     * @param {Server} server
     * @returns {Promise<void>}
     */
    const selectServer = async (server) => {
        if (!tray) return logger.warn("Attempted to select server without tray");

        const savedServers = /** @type {Server[]} */ (store.get("servers"));
        const savedServer = savedServers.find((server) => server.isSelected);
        if (savedServer && server.serverId === savedServer.serverId)
            return logger.debug("Tried to select server that's already selected");

        const servers = savedServers.map((savedServer) => {
            return savedServer.serverId === server.serverId
                ? { ...savedServer, isSelected: true }
                : { ...savedServer, isSelected: false };
        });

        store.set("servers", servers);

        tray.setContextMenu(buildTrayMenu(servers));

        await stopPresenceUpdater();
        startPresenceUpdater();
    };

    /**
     * @param {Server} serverToRemove
     * @returns {void}
     */
    const removeServer = (serverToRemove) => {
        if (!tray) return logger.warn("Attempted to remove server without tray");

        let wasSelected = false;
        const servers = /** @type {Server[]} */ (store.get("servers")).filter((server) => {
            if (server.serverId !== serverToRemove.serverId) {
                return true;
            } else {
                if (server.isSelected) wasSelected = true;
                return false;
            }
        });

        store.set("servers", servers);

        tray.setContextMenu(buildTrayMenu(servers));

        dialog.showMessageBox({
            type: "info",
            title: name,
            message: `Successfully removed server from the server list. ${
                wasSelected
                    ? "Since this was the currently selected server, your presence will no longer be displayed."
                    : ""
            }`,
        });
    };

    /**
     * @param {Server[]} servers
     * @returns {Menu}
     */
    const buildTrayMenu = (servers) => {
        const serverSelectionSubmenu = /** @type {import("electron").MenuItemConstructorOptions[]} */ ([]);

        for (const server of servers) {
            serverSelectionSubmenu.push({
                label: `${server.address} (${server.serverName})`,
                submenu: [
                    {
                        type: "normal",
                        label: `Selected Server: ${booleanToYN(server.isSelected)}`,
                        enabled: false,
                    },
                    {
                        label: "Remove Server",
                        click: () => removeServer(server),
                    },
                    {
                        label: "Select Server",
                        click: () => selectServer(server),
                    },
                ],
            });
        }

        const contextMenu = Menu.buildFromTemplate([
            {
                type: "checkbox",
                label: "Display as Status",
                click: () => toggleDisplay(),
                checked: /** @type {boolean} */ (store.get("doDisplayStatus")),
            },
            {
                label: "Show external buttons (IMDb...)",
                type: "checkbox",
                checked: /** @type {boolean} */ (store.get("showExternalButtons")),
                click: () => {
                    const isUsing = store.get("showExternalButtons");

                    store.set({ showExternalButtons: !isUsing });
                },
            },
            {
                type: "separator",
            },
            {
                label: "Add Server",
                click: () => loadWindow("configure", { x: 600, y: 300 }),
            },
            {
                label: "Select Server",
                submenu: serverSelectionSubmenu,
            },
            {
                type: "separator",
            },
            {
                label: "Enable Debug Logging",
                type: "checkbox",
                checked: /** @type {boolean} */ (store.get("enableDebugLogging")),
                click: () => {
                    const isEnabled = store.get("enableDebugLogging");

                    logger.enableDebugLogging = !isEnabled;
                    store.set({ enableDebugLogging: !isEnabled });
                },
            },
            {
                label: "Show Logs",
                click: () => shell.openPath(logger.logPath),
            },
            {
                label: "Reset App",
                click: () => resetApp(),
            },
            {
                type: "separator",
            },
            {
                label: "Restart App",
                click: () => {
                    app.quit();
                    app.relaunch();
                },
            },
            {
                label: "Quit",
                role: "quit",
            },
            {
                type: "separator",
            },
            {
                type: "normal",
                label: `${name} v${version}`,
                enabled: false,
            },
        ]);

        return contextMenu;
    };

    const moveToTray = () => {
        tray = new Tray(path.join(__dirname, "icons", "tray.png"));

        const servers = /** @type {Server[]} */ (store.get("servers"));
        const contextMenu = buildTrayMenu(servers);

        tray.setToolTip(name);
        tray.setContextMenu(contextMenu);

        appBarHide(true);
    };

    const disconnectRPC = async () => {
        if (rpc) {
            logger.info("Disconnecting from Discord");
            clearTimeout(connectRPCTimeout);
            const rpcc = rpc;
            rpc = null;
            // @ts-expect-error
            rpcc.transport.removeAllListeners("close");
            await rpcc.user?.clearActivity().catch(() => null);
            await rpcc.destroy().catch(() => null);
        }
    };

    const connectRPC = () => {
        return new Promise((resolve) => {
            connectRPCTimeout = null;
            if (rpc) return logger.warn("Attempted to connect to RPC pipe while already connected");

            const server = getSelectedServer();
            if (!server) return logger.warn("No selected server");
            rpc = new DiscordRPC.Client({ transport: "ipc", clientId });

            rpc.once('ready', () => {
                logger.info(`RPC client ready`);
                resolve();
            });

            // @ts-expect-error
            rpc.transport.once("close", () => {
                disconnectRPC();
                logger.warn(
                    `Discord RPC connection closed. Attempting to reconnect in ${discordConnectRetryMS / 1000} seconds`
                );

                if (!connectRPCTimeout) {
                    connectRPCTimeout = setTimeout(connectRPC, discordConnectRetryMS);
                }
            });

            // @ts-expect-error
            rpc.transport.once("open", () => {
                logger.info(`Connected to Discord`);
            });

            rpc.login()
                .catch((e) => {
                    logger.error(
                        `Failed to connect to Discord. Attempting to reconnect in ${
                            discordConnectRetryMS / 1000
                        } seconds`
                    );
                    logger.error(e);
                    rpc = null;
                });
        });
    };

    const startPresenceUpdater = async () => {
        const data = getSelectedServer();
        if (!data) return logger.warn("No selected server");

        jfc = new JFClient(data, {
            deviceName: name,
            deviceId: /** @type {string} */ (store.get("UUID")),
            deviceVersion: version,
            iconUrl: iconUrl,
        });

        logger.debug("Attempting to log into server");
        logger.debug(scrubObject(data, "username", "password", "address"));

        await disconnectRPC();
        await connectRPC();

        try {
            await jfc.login();
            logger.info('Logged in to Jellyfin');
        } catch (err) {
            logger.error("Failed to authenticate. Retrying in 30 seconds.");
            logger.error(err);
            setTimeout(startPresenceUpdater, JFConnectRetryMS);
            return;
        }

        setPresence();
        if (!presenceUpdate) presenceUpdate = setInterval(setPresence, presenceUpdateIntervalMS);
    };

    const setPresence = async () => {
        if (!rpc || !jfc) return logger.debug("No rpc or jfc");
        if (!store.get("doDisplayStatus")) return logger.debug("doDisplayStatus disabled, not setting status");

        const showExternalButtons = /** @type {boolean} */ (store.get("showExternalButtons"));
        const server = getSelectedServer();
        if (!server) return logger.warn("No selected server");

        try {
            let sessions;

            try {
                sessions = await jfc.getSessions(maximumSessionInactivity);
            } catch (err) {
                return logger.error(`Failed to get sessions: ${err}`);
            }

            const session = sessions.find(
                (session) =>
                    session.NowPlayingItem !== undefined &&
                    session.UserName &&
                    session.UserName.toLowerCase() === server.username.toLowerCase()
            );

            if (session) {
                const NPItem = session.NowPlayingItem;
                // remove client IP addresses (hopefully this takes care of all of them)
                logger.debug(scrubObject(session, "RemoteEndPoint"));

                const currentEpochSeconds = new Date().getTime() / 1000;
                const startTimestamp = Math.round(
                    currentEpochSeconds - Math.round(session.PlayState.PositionTicks / 10000 / 1000)
                );
                const endTimestamp = Math.round(
                    currentEpochSeconds +
                        Math.round(
                            (session.NowPlayingItem.RunTimeTicks - session.PlayState.PositionTicks) / 10000 / 1000
                        )
                );

                logger.debug(
                    `Time until media end: ${endTimestamp - currentEpochSeconds}, been playing since: ${startTimestamp}`
                );

                setTimeout(setPresence, (endTimestamp - currentEpochSeconds) * 1000 + 1500);

                const defaultProperties = {
                    largeImageKey: "jellyfin",
                    largeImageText: `${NPItem.Type === "Audio" ? "Listening" : "Watching"} on ${session.Client}`,
                    smallImageKey: session.PlayState.IsPaused ? "pause" : "play",
                    smallImageText: session.PlayState.IsPaused ? "Paused" : "Playing",
                    instance: false,
                    type: 3, // Watching
                    endTimestamp: 1, // Discord by default does calculate time elapsed, but only shows it to other users. So set to epoch + 1 it will stay at 00:00
                };
                if (!session.PlayState.IsPaused) {
                    defaultProperties.startTimestamp = startTimestamp;
                    defaultProperties.endTimestamp = endTimestamp;
                }
                if (showExternalButtons && NPItem.ExternalUrls) {
                    defaultProperties.buttons = [];
                    NPItem.ExternalUrls.forEach((externalUrl, externalUrlIndex) => {
                        if (externalUrlIndex >= 2) return;
                        defaultProperties.buttons.push({ label: `View on ${externalUrl.Name}`, url: externalUrl.Url });
                    })
                }

                switch (NPItem.Type) {
                    case "Episode": {
                        // prettier-ignore
                        const seasonNum = NPItem.ParentIndexNumber;
                        // prettier-ignore
                        const episodeNum = NPItem.IndexNumber;

                        await rpc.user?.setActivity({
                            ...defaultProperties,
                            details: `${NPItem.SeriesName}${seasonNum > 1 ? ` ${NPItem.SeasonName}` : ''}`,
                            state: `${
                                seasonNum ? `S1${seasonNum}:` : ""
                            }${episodeNum ? `E${episodeNum}` : ""} - ${NPItem.Name}`,
                            largeImageKey: `${jfc.serverAddress}/Items/${NPItem.SeriesId}/Images/Primary`,
                        });
                        break;
                    }
                    case "Movie": {
                        rpc.user?.setActivity({
                            ...defaultProperties,
                            details: `${NPItem.Name}${NPItem.ProductionYear ? ` (${NPItem.ProductionYear})` : ""}`,
                            largeImageKey: `${jfc.serverAddress}/Items/${NPItem.Id}/Images/Primary`,
                        });
                        break;
                    }
                    case "MusicVideo": {
                        const artists = NPItem.Artists.splice(0, 3);
                        rpc.user?.setActivity({
                            ...defaultProperties,
                            details: `${NPItem.Name} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ""}`,
                            state: `By ${artists.length ? artists.join(", ") : "Unknown Artist"}`,
                            largeImageKey: `${jfc.serverAddress}/Items/${NPItem.Id}/Images/Primary`,
                        });
                        break;
                    }
                    case "Audio": {
                        const artists = NPItem.Artists.splice(0, 3);
                        const albumArtists = NPItem.AlbumArtists.map((ArtistInfo) => ArtistInfo.Name).splice(0, 3);

                        rpc.user?.setActivity({
                            ...defaultProperties,
                            details: `${NPItem.Name} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ""}`,
                            state: `By ${
                                artists.length
                                    ? artists.join(", ")
                                    : albumArtists.length
                                    ? albumArtists.join(", ")
                                    : "Unknown Artist"
                            }`,
                            largeImageKey: `${jfc.serverAddress}/Items/${NPItem.Id}/Images/Primary`,
                        });
                        break;
                    }
                    default:
                        rpc.user?.setActivity({
                            ...defaultProperties,
                            details: "Watching Other Content",
                            state: NPItem.Name,
                        });
                }
            } else {
                logger.debug("No session, clearing activity");
                if (rpc) await rpc.user?.clearActivity();
            }
        } catch (error) {
            logger.error(`Failed to set activity: ${error}`);
        }
    };

    ipcMain.on("ADD_SERVER", async (event, data) => {
        logger.debug("Is first setup: " + !store.get("isConfigured"));

        const emptyFields = Object.entries(data)
            .filter((entry) => !entry[1] && entry[0] !== "password") // where entry[1] is the value, and if the field password is ignore it (emby and jelly dont require you to have a pw, even though you should even on local network)
            .map((field) => field[0]); // we map empty fields by their names

        if (emptyFields.length) {
            mainWindow.webContents.send("VALIDATION_ERROR", emptyFields);
            dialog.showMessageBox(mainWindow, {
                type: "error",
                title: name,
                message: "Please make sure that all the fields are filled in!",
            });
            return;
        }

        let client = new JFClient(data, {
            deviceName: name,
            deviceId: /** @type {string} */ (store.get("UUID")),
            deviceVersion: version,
            iconUrl: iconUrl,
        });

        logger.debug("Attempting to log into server");
        logger.debug(scrubObject(data, "username", "password", "address"));

        let serverInfo;
        try {
            await client.login();
            serverInfo = await client.getSystemInfo();
        } catch (error) {
            logger.error(error);
            dialog.showMessageBox(mainWindow, {
                type: "error",
                title: name,
                message: "Invalid server address or login credentials",
            });
            event.reply("RESET");
            return;
        }

        if (!store.get("isConfigured")) {
            // convert
            store.set({
                servers: [
                    {
                        ...data,
                        isSelected: true,
                        serverId: serverInfo.Id,
                        serverName: serverInfo.ServerName,
                    },
                ],
                isConfigured: true,
                doDisplayStatus: true,
            });

            moveToTray();
            startPresenceUpdater();
        } else {
            logger.debug(store.get("servers"));

            const configuredServers = /** @type {Server[]} */ (store.get("servers"));

            if (configuredServers.some((configuredServer) => configuredServer.serverId === serverInfo.Id)) {
                dialog.showMessageBox(mainWindow, {
                    type: "error",
                    title: name,
                    message: "You already configured this server, you can enable it from the tray.",
                });

                event.reply("RESET", true);
            } else {
                const newServer = {
                    ...data,
                    isSelected: false,
                    serverId: serverInfo.Id,
                    serverName: serverInfo.ServerName,
                };

                mainWindow.hide();

                addServer(newServer);

                if (getSelectedServer()) {
                    const res = await dialog.showMessageBox({
                        type: "info",
                        title: name,
                        message: "Your server has been successfully added. Would you like to select it automatically?",
                        buttons: ["Yes", "No"],
                    });

                    if (res.response === 0) {
                        selectServer(newServer);
                    }
                } else {
                    dialog.showMessageBox({
                        type: "info",
                        title: name,
                        message: "Your server has been successfully added and has been automatically selected.",
                    });

                    selectServer(newServer);
                }

                appBarHide(true);
            }
        }
    });

    if (app.isReady()) {
        startApp();
    } else {
        app.once("ready", startApp);
    }
})();
