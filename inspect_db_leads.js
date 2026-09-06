const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'pipeline.db'));
const rows = db.prepare('SELECT id, name, company, email, stage, qualification_score, estimated_burn FROM pipeline_leads').all();
console.log(`Found ${rows.length} leads in pipeline.db:`);
console.log(JSON.stringify(rows, null, 2));
