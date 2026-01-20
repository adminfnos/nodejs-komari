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

// --- Komari 变量 (请在平台环境变量中填写) ---
// NEZHA_SERVER 填 https://komari.afnos86.xx.kg
// NEZHA_KEY 填你的 Token (例如 A2NP...)
const NEZHA_SERVER = process.env.NEZHA_SERVER || ''; 
const NEZHA_KEY = process.env.NEZHA_KEY || '';       

// --- Argo 变量 ---
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';
const ARGO_AUTH = process.env.ARGO_AUTH || '';
const ARGO_PORT = process.env.ARGO_PORT || 8001;
const CFIP = process.env.CFIP || 'cdns.doon.eu.org';
const CFPORT = process.env.CFPORT || 443;
const NAME = process.env.NAME || '';

// 目录初始化
if (!fs.existsSync(FILE_PATH)) fs.mkdirSync(FILE_PATH, { recursive: true });

const npmName = "komari_agent";
const webName = "xray_bin";
const botName = "argo_bin";
const npmPath = path.join(FILE_PATH, npmName);
const webPath = path.join(FILE_PATH, webName);
const botPath = path.join(FILE_PATH, botName);
const bootLogPath = path.join(FILE_PATH, 'boot.log');

app.get("/", (req, res) => res.send("Service is active"));

/**
 * 自动获取 Komari 最新版本的下载链接
 */
async function getKomariUrl(arch) {
    try {
        console.log(`[System] Fetching latest Komari assets for ${arch}...`);
        const res = await axios.get('https://api.github.com/repos/komari-monitor/komari-agent/releases/latest', { timeout: 10000 });
        
        // 在资源列表中匹配包含 linux 和对应架构的文件 (忽略 .sha256 结尾的文件)
        const asset = res.data.assets.find(a => 
            a.name.toLowerCase().includes('linux') && 
            a.name.toLowerCase().includes(arch) &&
            !a.name.endsWith('.sha256')
        );
        
        if (asset) {
            console.log(`[System] Found latest version: ${res.data.tag_name}`);
            return asset.browser_download_url;
        }
    } catch (e) {
        console.error(`[System] GitHub API Error: ${e.message}, using fallback URL.`);
    }
    // 如果 API 失败，使用当前已知的 1.1.40 稳定版地址
    return `https://github.com/komari-monitor/komari-agent/releases/download/v1.1.40/komari-agent-linux-${arch}`;
}

/**
 * 通用下载函数
 */
async function download(name, url, savePath) {
    if (!url) return;
    try {
        const writer = fs.createWriteStream(savePath);
        const response = await axios({ method: 'get', url: url, responseType: 'stream', timeout: 60000 });
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
    console.log(`[System] Architecture detected: ${arch}`);

    // 1. 获取 Komari 链接
    let komariUrl = null;
    if (NEZHA_SERVER && NEZHA_KEY) {
        komariUrl = await getKomariUrl(arch);
    }

    // 2. 准备下载任务
    const xrayUrl = isArm ? "https://arm64.ssss.nyc.mn/web" : "https://amd64.ssss.nyc.mn/web";
    const argoUrl = isArm ? "https://arm64.ssss.nyc.mn/bot" : "https://amd64.ssss.nyc.mn/bot";
    
    // 依次执行下载
    await download('Xray', xrayUrl, webPath);
    await download('Argo', argoUrl, botPath);
    if (komariUrl) await download('Komari', komariUrl, npmPath);

    // 3. 启动 Xray
    if (fs.existsSync(webPath)) {
        const config = {
            log: { loglevel: 'none' },
            inbounds: [{ port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID }], fallbacks: [{ path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 30
