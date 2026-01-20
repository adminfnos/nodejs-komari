const express = require("express");
const app = express();
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);

// --- 基础配置 ---
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;
const FILE_PATH = process.env.FILE_PATH || './tmp';
const SUB_PATH = process.env.SUB_PATH || 'sub';
const UUID = process.env.UUID || '9afd1229-b893-40c1-84dd-51e7ce204913';

// --- Komari 变量 ---
const NEZHA_SERVER = process.env.NEZHA_SERVER || ''; 
const NEZHA_KEY = process.env.NEZHA_KEY || '';       

// --- Argo 变量 ---
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || 8001;
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const npmName = "komari_agent";
const webName = "xray_bin";
const botName = "argo_bin";
const npmPath = path.join(FILE_PATH, npmName);
const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const bootLogPath = path.join(FILE_PATH, 'boot.log');

app.get("/", (req, res) => res.send("Service is active"));

// 获取 Komari 最新下载链接的函数
async function getKomariUrl(arch) {
    try {
        const res = await axios.get('https://api.github.com/repos/komari-monitor/komari-agent/releases/latest');
        // 在 release 资源中寻找包含 linux 和对应架构的下载项
        const asset = res.data.assets.find(a => a.name.includes('linux') && a.name.includes(arch));
        return asset ? asset.browser_download_url : null;
    } catch (e) {
        console.error("Failed to fetch latest Komari URL from GitHub API");
        return null;
    }
}

async function download(name, url, savePath) {
    if (!url) return;
    try {
        const writer = fs.createWriteStream(savePath);
        const response = await axios({ method: 'get', url: url, responseType: 'stream', timeout: 30000 });
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                fs.chmodSync(savePath, 0o775);
                console.log(`[OK] ${name} downloaded.`);
                resolve();
            });
            writer.on('error', reject);
        });
    } catch (e) {
        console.error(`[Error] ${name} download failed: ${e.message}`);
    }
}

async function main() {
    const isArm = os.arch().includes('arm');
    const arch = isArm ? 'arm64' : 'amd64';
    console.log(`Architecture: ${arch}`);

    // 1. 下载 Xray 和 Argo (这两个源比较稳定)
    const xrayUrl = isArm ? "https://arm64.ssss.nyc.mn/web" : "https://amd64.ssss.nyc.mn/web";
    const argoUrl = isArm ? "https://arm64.ssss.nyc.mn/bot" : "https://amd64.ssss.nyc.mn/bot";
    
    await Promise.all([
        download('Xray', xrayUrl, webPath),
        download('Argo', argoUrl, botPath)
    ]);

    // 2. 动态获取 Komari 下载链接并下载
    if (NEZHA_SERVER && NEZHA_KEY) {
        console.log("Fetching latest Komari download URL...");
        const komariUrl = await getKomariUrl(arch);
        if (komariUrl) {
            console.log(`Found Komari URL: ${komariUrl}`);
            await download('Komari', komariUrl, npmPath);
        } else {
            console.error("Could not find a suitable Komari binary for this architecture.");
        }
    }

    // --- 启动逻辑 ---
    if (fs.existsSync(webPath)) {
        const config = {
            log: { loglevel: 'none' },
            inbounds: [{ port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID }], fallbacks: [{ path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
            { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/vless-argo" } } },
            { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } } },
            { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", wsSettings: { path: "/trojan-argo" } } }],
            outbounds: [{ protocol: "freedom" }]
        };
        fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config));
        exec(`nohup ${webPath} -c ${FILE_PATH}/config.json >/dev/null 2>&1 &`);
        console.log("Xray started.");
    }

    if (fs.existsSync(npmPath) && NEZHA_SERVER && NEZHA_KEY) {
        // 修正启动参数：官方脚本使用的是 -e (entrypoint) 和 -t (token)
        exec(`nohup ${npmPath} -e ${NEZHA_SERVER} -t ${NEZHA_KEY} >/dev/null 2>&1 &`);
        console.log("Komari agent started.");
    }

    if (fs.existsSync(botPath)) {
        let argoArgs = ARGO_AUTH.length > 120 
            ? `tunnel --no-autoupdate --protocol http2 run --token ${ARGO_AUTH}`
            : `tunnel --no-autoupdate --protocol http2 --logfile ${bootLogPath} --url http://localhost:${ARGO_PORT}`;
        exec(`nohup ${botPath} ${argoArgs} >/dev/null 2>&1 &`);
        console.log("Argo started.");
    }

    // 订阅生成
    setTimeout(() => {
        let domain = ARGO_DOMAIN;
        if (!domain && fs.existsSync(bootLogPath)) {
            const log = fs.readFileSync(bootLogPath, 'utf-8');
            const match = log.match(/https?:\/\/([^ ]*trycloudflare\.com)/);
            if (match) domain = match[1];
        }
        if (domain) {
            const nodeName = NAME || 'Komari-Node';
            const subTxt = `vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${domain}&type=ws&host=${domain}&path=%2Fvless-argo#${nodeName}`;
            app.get(`/${SUB_PATH}`, (req, res) => res.send(Buffer.from(subTxt).toString('base64')));
            console.log(`Sub link ready at: /${SUB_PATH}`);
        }
    }, 15000);
}

main().catch(console.error);
app.listen(PORT, () => console.log(`Server is live on port ${PORT}`));
