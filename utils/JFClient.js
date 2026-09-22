const bent = require("bent");

class JFClient {
    /**
     * @param {Object} serverCredentials
     * @param {string} serverCredentials.address
     * @param {string} serverCredentials.port
     * @param {string} serverCredentials.protocol HTTP or HTTPS
     * @param {string} serverCredentials.username
     * @param {string} serverCredentials.password
     *
     * @param {Object} deviceInfo
     * @param {string} deviceInfo.appName
     * @param {string} deviceInfo.deviceName
     * @param {string} deviceInfo.deviceId
     * @param {string} deviceInfo.deviceVersion,
     * @param {string|undefined} deviceInfo.iconUrl URL to the icon displayed under the devices page
     */
    constructor(serverCredentials, deviceInfo) {
        this.address = serverCredentials.address;
        this.port = serverCredentials.port;
        this.protocol = serverCredentials.protocol;
        this.username = serverCredentials.username;
        this.password = serverCredentials.password;

        this.appName = deviceInfo.appName;
        this.deviceName = deviceInfo.deviceName;
        this.deviceId = deviceInfo.deviceId;
        this.deviceVersion = deviceInfo.deviceVersion;
        this.iconUrl = deviceInfo.iconUrl;

        this.userId;
        this.accessToken;
    }

    /**
     * @returns {string}
     */
    get serverAddress() {
        const url = new URL(`${this.protocol}://${this.address}`);
        url.port = this.port.toString();
        return url.toString().replace(/\/+$/, "");
    }

    get isAuthenticated() {
        return this.accessToken !== undefined;
    }

    get headers() {
        const headers = {
            "User-Agent": `${this.appName}/${this.deviceVersion}`,
            "Authorization": this.authorization,
        };

        if (this.accessToken) {
            headers["Authorization"] += `, Token="${this.accessToken}"`;
        }

        return headers;
    }

    get authorization() {
        return [
            `MediaBrowser Client="${this.appName}"`,
            `Device="${this.deviceName}"`,
            `DeviceId="${this.deviceId}"`,
            `Version="${this.deviceVersion}"`,
        ].join(", ");
    }

    /**
     * @param {number} activeWithinSeconds
     * @returns {Promise<Array<Object>>} the sessions
     */
    async getSessions(activeWithinSeconds) {
        return await bent("GET", "json", 200)(
            `${this.serverAddress}/Sessions${activeWithinSeconds ? `?ActiveWithinSeconds=${activeWithinSeconds}` : ""}`,
            undefined,
            this.headers
        );
    }

    /**
     * @returns {Promise<void>}
     */
    async assignDeviceCapabilities() {
        await bent("POST", 204)(
            `${this.serverAddress}/Sessions/Capabilities/Full`,
            {
                IconUrl: this.iconUrl,
            },
            this.headers
        );
    }

    /**
     * @returns {Promise<{Id: string, ServerName: string}>}
     */
    async getSystemInfo() {
        return await bent("GET", "json", 200)(`${this.serverAddress}/System/Info`, undefined, this.headers);
    }

    /**
     * @returns {Promise<void>}
     */
    async login() {
        if (this.accessToken) return;
        const res = await bent("POST", "json", 200)(
            `${this.serverAddress}/Users/AuthenticateByName`,
            {
                Username: this.username,
                Pw: this.password,
            },
            {
                Authorization: this.authorization,
            }
        );
        this.accessToken = res.AccessToken;
        this.userId = res.User.Id;

        if (this.iconUrl) {
            try {
                await this.assignDeviceCapabilities();
            } catch (error) {
                throw new Error(`Failed to set device icon: ${error}`);
            }
        }
    }

    /**
     * @returns {Promise<void>}
     */
    async logout() {
        if (this.accessToken) {
            await bent("POST")(`${this.serverAddress}/Sessions/Logout`, undefined, this.headers);
            this.accessToken = null;
            this.userId = null;
        }
    }
}

module.exports = JFClient;
