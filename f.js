const axios = require('axios');
const fs = require('fs');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const chalk = require('chalk');
const dns = require('dns').promises;

const config = {
    CAPTCHA_SERVICE: '2captcha', // hanya support 2captcha
    CAPTCHA_API_KEY: 'API_KEY_ANDA', // apikey mu
    WALLET_FILE: 'wallets.txt',
    PROXY_FILE: 'proxies.txt',
    FAUCET_URL: 'https://faucet.testnet.riselabs.xyz',
    API_URL: 'https://faucet-api.riselabs.xyz',
    CLOUDFLARE_SITEKEY: '0x4AAAAAABDerdTw43kK5pDL',
    TOKENS_TO_CLAIM: ['ETH', 'RISE'], // bisa diubah atau tambah 'RISE', 'MOG', 'PEPE', 'USDC', 'USDT', 'WBTC'
    DELAY_BETWEEN_WALLETS: 30000,
    DELAY_BETWEEN_TOKENS: 15000,
    CAPTCHA_TIMEOUT: 180000,
    PROXY_ROTATION: 'random',
    PROXY_ENABLED: true,
    COOLDOWN_HOURS: 2,
};

let proxies = [];
let currentProxyIndex = 0;
let currentProxy = null;

async function main() {
    while (true) {
        console.log(chalk.yellow('\n==============================================='));
        console.log(chalk.yellow('|   RiseLabs Faucet Claimer - FULL AUTOMATIC  |'));
        console.log(chalk.yellow('|        Thank You For Using My script        |'));
        console.log(chalk.yellow('|    Github: https://github.com/biasaajash    |'));
        console.log(chalk.yellow('===============================================\n'));

        if (!config.CAPTCHA_API_KEY || config.CAPTCHA_API_KEY === 'API_KEY_ANDA') {
            console.error(chalk.red('[ERROR] Missing Captcha API key'));
            console.error(chalk.red('Get one from: https://2captcha.com/'));
            process.exit(1);
        }

        const wallets = loadWallets();
        if (wallets.length === 0) {
            console.error(chalk.red('[ERROR] No wallets found in', config.WALLET_FILE));
            process.exit(1);
        }

        if (config.PROXY_ENABLED) {
            proxies = loadProxies();
            console.log(chalk.blue(`[PROXY] Loaded ${proxies.length} proxies`));
        }

        console.log(chalk.green(`Starting process for ${wallets.length} wallets...`));

        for (const [index, wallet] of wallets.entries()) {
            console.log(chalk.magenta(`\nProcessing wallet ${index + 1}/${wallets.length}: ${wallet}`));
            
            try {
                await processWallet(wallet);
            } catch (error) {
                console.error(chalk.red(`Failed to process wallet ${wallet}:`, error.message));
            }

            if (index < wallets.length - 1) {
                const delaySec = config.DELAY_BETWEEN_WALLETS / 1000;
                console.log(chalk.blue(`Waiting ${delaySec} seconds before next wallet...`));
                await sleep(config.DELAY_BETWEEN_WALLETS);
            }
        }

        console.log(chalk.green('\nCOMPLETED! All wallets processed.'));
        await performCooldown();
    }
}

async function performCooldown() {
    const cooldownMs = config.COOLDOWN_HOURS * 60 * 60 * 1000;
    console.log(chalk.yellow(`\nStarting ${config.COOLDOWN_HOURS} hour cooldown period...`));
    
    const endTime = Date.now() + cooldownMs;
    while (Date.now() < endTime) {
        const remaining = Math.ceil((endTime - Date.now()) / 1000);
        const hours = Math.floor(remaining / 3600);
        const minutes = Math.floor((remaining % 3600) / 60);
        const seconds = remaining % 60;
        
        process.stdout.write(chalk.blue(`\rNext run in: ${hours}h ${minutes}m ${seconds}s  `));
        await sleep(1000);
    }
    
    console.log(chalk.green('\nCooldown complete! Restarting process...'));
}

async function processWallet(wallet) {
    for (const token of config.TOKENS_TO_CLAIM) {
        let success = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!success && attempts < maxAttempts) {
            attempts++;
            console.log(chalk.cyan(`Attempt ${attempts} to claim ${token}`));

            try {
                await claimToken(wallet, token);
                success = true;
            } catch (error) {
                console.error(chalk.red(`Attempt ${attempts} failed:`, error.message));
                if (attempts < maxAttempts) {
                    await sleep(5000 * attempts);
                }
            }

            if (token !== config.TOKENS_TO_CLAIM[config.TOKENS_TO_CLAIM.length - 1]) {
                await sleep(config.DELAY_BETWEEN_TOKENS);
            }
        }

        if (!success) {
            console.error(chalk.red(`Failed to claim ${token} after ${maxAttempts} attempts`));
        }
    }
}

async function claimToken(wallet, token) {
    const axiosInstance = await createAxiosInstance();

    console.log(chalk.yellow('Solving Cloudflare Turnstile...'));
    const turnstileToken = await solveCaptcha();
    if (!turnstileToken) throw new Error('Failed to solve captcha');

    console.log(chalk.blue('Sending claim request...'));
    const response = await axiosInstance.post(
        `${config.API_URL}/faucet/multi-request`,
        {
            address: wallet,
            tokens: [token],
            turnstileToken: turnstileToken
        },
        {
            headers: {
                'Origin': config.FAUCET_URL,
                'Referer': `${config.FAUCET_URL}/`,
                'Content-Type': 'application/json'
            }
        }
    );

    if (response.data.summary.succeeded > 0) {
        const result = response.data.results.find(r => r.tokenSymbol === token);
        console.log(chalk.green(`Successfully claimed ${token}!`));
        console.log(chalk.green(`Amount: ${result.amount} ${token}`));
        console.log(chalk.green(`TX Hash: ${result.tx || 'Pending'}`));
    } else {
        const reason = response.data.results?.[0]?.reason || 'Unknown reason';
        throw new Error(`Claim rejected: ${reason}`);
    }
}

async function solveCaptcha() {
    return await solveWith2Captcha();
}

async function solveWith2Captcha() {
    const startTime = Date.now();
    const axiosInstance = await createAxiosInstance();

    const createTaskUrl = `https://2captcha.com/in.php?key=${config.CAPTCHA_API_KEY}&method=turnstile&sitekey=${config.CLOUDFLARE_SITEKEY}&pageurl=${config.FAUCET_URL}`;
    
    console.log(chalk.yellow('Creating 2Captcha task...'));
    const createResponse = await axiosInstance.get(createTaskUrl);
    
    if (!createResponse.data.startsWith('OK|')) {
        throw new Error(`Failed to create task: ${createResponse.data}`);
    }
    
    const taskId = createResponse.data.split('|')[1];
    console.log(chalk.blue(`Task ID: ${taskId}, waiting for solution...`));

    const checkUrl = `https://2captcha.com/res.php?key=${config.CAPTCHA_API_KEY}&action=get&id=${taskId}`;
    
    while (Date.now() - startTime < config.CAPTCHA_TIMEOUT) {
        await sleep(5000);
        console.log(chalk.blue('Checking captcha result...'));
        
        const checkResponse = await axiosInstance.get(checkUrl);
        
        if (checkResponse.data === 'CAPCHA_NOT_READY') {
            continue;
        }
        
        if (checkResponse.data.startsWith('OK|')) {
            console.log(chalk.green('Captcha solved successfully'));
            return checkResponse.data.split('|')[1];
        }
        
        throw new Error(`Captcha error: ${checkResponse.data}`);
    }
    
    throw new Error('2Captcha solving timeout');
}

function loadWallets() {
    try {
        return fs.readFileSync(config.WALLET_FILE, 'utf8')
            .split('\n')
            .map(w => w.trim())
            .filter(w => w.startsWith('0x') && w.length === 42);
    } catch (error) {
        console.error(chalk.red('Error loading wallets:', error.message));
        return [];
    }
}

function loadProxies() {
    try {
        return fs.readFileSync(config.PROXY_FILE, 'utf8')
            .split('\n')
            .map(p => p.trim())
            .filter(p => p.length > 0);
    } catch (error) {
        console.warn(chalk.yellow('No proxies loaded, using direct connection'));
        return [];
    }
}

async function createAxiosInstance() {
    if (!config.PROXY_ENABLED || proxies.length === 0) {
        console.log(chalk.yellow('Using direct connection (no proxy)'));
        return axios;
    }

    currentProxy = getNextProxy();
    const proxyUrl = new URL(currentProxy.includes('://') ? currentProxy : `http://${currentProxy}`);
    
    try {
        const hostname = proxyUrl.hostname;
        let ipAddress = hostname;
        
        if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
            try {
                const addresses = await dns.resolve(hostname);
                ipAddress = addresses[0] || hostname;
            } catch (err) {
                console.warn(chalk.yellow(`Could not resolve proxy hostname: ${hostname}, using hostname instead`));
                ipAddress = hostname;
            }
        }
        
        console.log(chalk.blue(`Using proxy: IP: ${chalk.bold(ipAddress)}`));

        let agent;
        if (currentProxy.startsWith('socks')) {
            agent = new SocksProxyAgent(currentProxy);
        } else {
            agent = new HttpsProxyAgent(currentProxy);
        }

        return axios.create({
            httpsAgent: agent,
            httpAgent: agent,
            timeout: 30000
        });
    } catch (error) {
        console.error(chalk.red('Error creating proxy agent:', error.message));
        return axios;
    }
}

function getNextProxy() {
    if (proxies.length === 0) return null;

    if (config.PROXY_ROTATION === 'random') {
        return proxies[Math.floor(Math.random() * proxies.length)];
    } else {
        const proxy = proxies[currentProxyIndex];
        currentProxyIndex = (currentProxyIndex + 1) % proxies.length;
        return proxy;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
    console.error(chalk.red('\nFATAL ERROR:', error.message));
    process.exit(1);
});
