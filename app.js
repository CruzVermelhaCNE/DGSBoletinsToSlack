require('dotenv').config()
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
const {
    exit
} = require('process');
const {
    WebClient
} = require('@slack/web-api');

const slack_enabled = process.env.SLACK_ENABLE === "true";
const web = new WebClient(process.env.SLACK_TOKEN);

if (!fs.existsSync('database')) {
    fs.mkdirSync('database');
}

if (!fs.existsSync('pdf')) {
    fs.mkdirSync('pdf');
}


if (!fs.existsSync('database/situation_reports.json')) {
    fs.writeFileSync('database/situation_reports.json', JSON.stringify({}));
}

let situation_reports = JSON.parse(fs.readFileSync('database/situation_reports.json'));

function saveFiles() {
    fs.writeFileSync('database/situation_reports.json', JSON.stringify(situation_reports));
}

async function getMD5(path) {
    var fd = fs.createReadStream(path);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');

    // read all file and pipe it (write it) to the hash object
    fd.pipe(hash);
    let complete_md5 = await new Promise(function (resolve, reject) {
        fd.on('end', () => {
            hash.end();
            let hashread = hash.read();
            resolve(hashread);
        });
        fd.on('error', reject);
    });
    return complete_md5;
}

async function fetchReports() {
    let response = await axios.get('https://covid19.min-saude.pt/relatorio-de-situacao/');
    const $ = cheerio.load(response.data);
    const elements = $('.single_content ul li').get();
    for (element of elements) {
        let tag = $(element).html();
        const href_regex = new RegExp("href=\"([^\"]+)\"");
        let href = href_regex.exec(tag)[1];
        let date = tag.split("|")[1].substr(1, 10);
        let regex = new RegExp("Situa&#xE7;&#xE3;o n&#xBA; ([0-9]+)");
        let number = regex.exec(tag);
        if (number !== null) {
            // Situation Report
            number = number[1];
            let info = `Relatório de Situação nº ${number} - ${date}`;
            let pdf_path = `pdf/situation-report-${number}.pdf`;
            let pdf = fs.createWriteStream(pdf_path);
            try {
                let pdf_response = await axios({
                    method: "get",
                    url: href,
                    responseType: "stream"
                });
                pdf_response.data.pipe(pdf);
                const complete_download = new Promise(function (resolve, reject) {
                    pdf.on('finish', resolve);
                    pdf.on('error', reject);
                });
                await complete_download;
                const md5 = await getMD5(pdf_path);
                if (!(number in situation_reports)) {
                    situation_reports[number] = {
                        md5,
                        date,
                        ts: ""
                    };
                    if (slack_enabled) {
                        const result = await web.chat.postMessage({
                            text: info,
                            channel: process.env.SLACK_CHANNEL,
                        });
                        situation_reports[number].ts = result.message.ts;
                        const upload_res = await web.files.upload({
                            channels: process.env.SLACK_CHANNEL,
                            filename: `RelatorioSituacao${number}.pdf`,
                            file: fs.createReadStream(pdf_path),
                            filetype: "pdf",
                            thread_ts: situation_reports[number].ts
                        });
                    }
                } else {
                    if (situation_reports[number].md5 != md5) {
                        situation_reports[number].date = date;
                        situation_reports[number].md5 = md5;
                        if (slack_enabled) {
                            if (situation_reports[number].ts === "") {
                                const result = await web.chat.postMessage({
                                    text: info,
                                    channel: process.env.SLACK_CHANNEL,
                                });
                            } else {
                                const upload_res = await web.files.upload({
                                    channels: process.env.SLACK_CHANNEL,
                                    filename: `RelatorioSituacao${number}.pdf`,
                                    file: fs.createReadStream(pdf_path),
                                    filetype: "pdf",
                                    thread_ts: situation_reports[number].ts
                                });
                            }
                        }
                    } else {
                        continue;
                    }
                }
            }
            catch(exception) {
                situation_reports[number] = {
                    md5: "",
                    date,
                    ts: ""
                };
            }            
            saveFiles();
        }
    };
}

fetchReports();
setInterval(fetchReports, process.env.LOOP_TIME);