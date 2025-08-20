const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { standardizeRow } = require('./Standardize-input');

const SHEET_URL = process.env.SHEET_URL;
const TEMP_DIR = path.resolve(__dirname, '../tmp');
const SHEET_DUMP_FILE = path.join(TEMP_DIR, 'CloudSql.json');
const RESULTS_FILE = path.join(TEMP_DIR, 'cloudsql-results.json');
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, '../assets/presales-infra-mod-42a0bcd6a896.json');
const SERVICE_ACCOUNT = require(SERVICE_ACCOUNT_PATH);

const cloudsqlServiceEndpoints = {
  ondemand: 'http://localhost:5001/cloudsql',
  '1year': 'http://localhost:5002/cloudsql', 
  '3year': 'http://localhost:5003/cloudsql', 
};

if (!SHEET_URL) {
  console.error('❌ SHEET_URL is not defined.');
  process.exit(1);
}

const { google } = require('googleapis');

async function makeSheetPublic(spreadsheetId) {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: SERVICE_ACCOUNT.client_email,
      private_key: SERVICE_ACCOUNT.private_key,
    },
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  const drive = google.drive({ version: 'v3', auth });

  await drive.permissions.create({
    fileId: spreadsheetId,
    requestBody: {
      role: 'writer',        
      type: 'anyone',
      
    },
  });


  console.log(`[validate-and-run.js] 🌐 Sheet made public: anyone with the link can access it.📎 Sheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  console.log(`[validate-and-run.js] 📎 Sheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}


/**
 * @param {string} spreadsheetId - The ID of the spreadsheet to share.
 * @param {string[]} emails - Array of email addresses.
 */
async function shareSheetWithEmails(spreadsheetId, emails = []) {
    const auth = new google.auth.JWT({
      email: SERVICE_ACCOUNT.client_email,
      key: SERVICE_ACCOUNT.private_key,
      scopes: [
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets'
      ],
    });
  
    // Initialize Drive API
    const drive = google.drive({ version: 'v3', auth });
  
    try {
      await drive.permissions.create({
        fileId: spreadsheetId,
        requestBody: {
          role: 'writer',
          type: 'user',
          emailAddress: SERVICE_ACCOUNT.client_email,
        },
        sendNotificationEmail: false,
      });
  
      for (const email of emails) {
        if (!email.includes('@')) {
          console.warn(`Skipping invalid email: ${email}`);
          continue;
        }
  
        await drive.permissions.create({
          fileId: spreadsheetId,
          requestBody: {
            role: 'writer',
            type: 'user',
            emailAddress: email,
          },
          sendNotificationEmail: true,
        });
  
        console.log(`✅ Successfully shared with ${email}`);
      }
    } catch (err) {
      console.error(`❌ Critical error: ${err.message}`);
    }
  }
  


function extractSheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] || null;
}

async function getRowsFromSheet(sheetId, sheetTitle = 'CloudSql') {
  const doc = new GoogleSpreadsheet(sheetId);
  await doc.useServiceAccountAuth({
    client_email: SERVICE_ACCOUNT.client_email,
    private_key: SERVICE_ACCOUNT.private_key,
  });
  await doc.loadInfo();
  const sheet = doc.sheetsByTitle[sheetTitle];
  if (!sheet) throw new Error(`❌ Sheet "${sheetTitle}" not found.`);
  const rows = await sheet.getRows();
  return { rows, headers: sheet.headerValues };
}

async function sendTocloudsqlContainer(mode, payload) {
  const endpoint = cloudsqlServiceEndpoints[mode];
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    console.error(`[cloudsql-${mode}] ❌ Failed for Sl ${payload.Sl}`);
    return null;
  }

  return await res.json();
}

(async () => {
  try {
    const sheetId = extractSheetId(SHEET_URL);
    if (!sheetId) throw new Error(' Invalid Google Sheet URL');

    console.log('[validate-and-run.js]  Downloading CloudSql tab...');
    const { rows, headers } = await getRowsFromSheet(sheetId);

    if (!rows.length) throw new Error(' No rows found in CloudSql tab');
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

    const requiredFields = ['No. of Instances', 'Datacenter Location', 'OS with version'];
    const finalRows = [];

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const row = {};
      headers.forEach(header => {
        row[header] = rawRow[header];
      });
      row.Sl = i + 1;

      const missingFields = requiredFields.filter(field => !row[field]);
      if (missingFields.length > 0) {
        const errorMsg = `Missing required fields: ${missingFields.join(', ')}`;
        console.log(`[validate-and-run.js]  Skipping row ${row.Sl}: ${errorMsg}`);
        finalRows.push({ Sl: row.Sl, Error: errorMsg });
        continue;
      }

      const standardized = standardizeRow(row);
      finalRows.push(standardized);
      console.log(`[validate-and-run.js] ✅ Row ${row.Sl} standardized`);
    }

    fs.writeFileSync(SHEET_DUMP_FILE, JSON.stringify(finalRows, null, 2));
    console.log(`[validate-and-run.js] ✅ Processed data saved to: ${SHEET_DUMP_FILE}`);

    const cloudsqlResults = {};

    for (let i = 0; i < finalRows.length; i++) {
      const row = finalRows[i];
      if (row.Error) {
        cloudsqlResults[row.Sl] = { Sl: row.Sl, Error: row.Error };
        continue;
      }
    
      const isFirst = i === 0;
      const isLast = i === finalRows.length - 1;
      const rowWithMeta = { ...row, first: isFirst, last: isLast };
      console.log(rowWithMeta);
    
      console.log(`[validate-and-run.js] Sending Sl ${row.Sl} to cloudsql containers...`);
    
      const resultObj = { Sl: row.Sl, timestamp: new Date().toISOString() };
    
      const machineClass = row["Machine Class"]?.toLowerCase(); 
      const series = row["Series"]?.toUpperCase();  
      const hours = parseFloat(row["Avg no. of hrs"] || 0);

      console.log(` hours: ${hours}`);
      console.log(` machineClass: ${machineClass}`);
      console.log(` series: ${series}`);
    
      
        const [ ondemand, year1, year3] = await Promise.all(
          ['ondemand', '1year', '3year'].map(mode =>
            sendTocloudsqlContainer(mode, { ...rowWithMeta, mode }))
        );
    
        const results = {ondemand, '1year': year1, '3year': year3 };
    
        for (const mode of [ 'ondemand', '1year', '3year']) {
          const result = results[mode];
          resultObj[`${mode}_price`] = result?.price || null;
          resultObj[`${mode}_url`] = result?.url || null;
          resultObj[`${mode}_machineType`] = result?.machineType || null;
          resultObj[`${mode}_specs`] = result?.specs || null;
        }
        console.log(`[validate-and-run.js]  Completed cloudsql for Sl ${row.Sl}`);
      
    
    cloudsqlResults[row.Sl] = resultObj;
    console.log(`[validate-and-run.js] ✅ Completed cloudsql for Sl ${row.Sl}`);
    console.log(`[validate-and-run.js] ✅ Results: ${JSON.stringify(resultObj, null, 2)}`);
    
    
    }

    fs.writeFileSync(RESULTS_FILE, JSON.stringify(cloudsqlResults, null, 2));
    console.log(`[validate-and-run.js] ✅ Results written to ${RESULTS_FILE}`);

    const emailList = process.env.EMAILS?.split(',').map(e => e.trim()).filter(Boolean) || [];

    console.log('[validate-and-run.js] 📤 Creating new Google Sheet to store results...');

    const doc = new GoogleSpreadsheet();
    await doc.useServiceAccountAuth({
      client_email: SERVICE_ACCOUNT.client_email,
      private_key: SERVICE_ACCOUNT.private_key,
    });

    await doc.createNewSpreadsheetDocument({
      title: `GCP cloudsql Pricing Results - ${new Date().toLocaleString()}`
    });




    const sheet = await doc.addSheet({
      title: "cloudsql",
      headerValues: [
          'Sl', 'machineType', 'specs',
          'ondemand_price', 'ondemand_url',
          '1year_price', '1year_url',
          '3year_price', '3year_url',
          'timestamp'
      ]
  });

    const defaultSheet = doc.sheetsByTitle['Sheet1'];
    if (defaultSheet) {
    await defaultSheet.delete();
    }


    const resultArray = Object.values(cloudsqlResults).map(result => ({
      Sl: result.Sl,
      machineType: result.sud_machineType,
      specs: result.sud_specs,
      ondemand_price: result.ondemand_price,
      ondemand_url: result.ondemand_url,
      '1year_price': result['1year_price'],
      '1year_url': result['1year_url'],
      '3year_price': result['3year_price'],
      '3year_url': result['3year_url'],
      timestamp: result.timestamp
  }));

    await sheet.addRows(resultArray);

    await makeSheetPublic(doc.spreadsheetId);
    await shareSheetWithEmails(doc.spreadsheetId, emailList);


    

    
    console.log(`[validate-and-run.js] 📎 Sheet URL: https://docs.google.com/spreadsheets/d/${doc.spreadsheetId}`);


    
  } catch (err) {
    console.error('[validate-and-run.js] ❌ Failed:', err.message);
  }
})();