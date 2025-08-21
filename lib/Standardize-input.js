

function standardizeRow(row) {
  const updatedRow = { ...row };
  console.log(`[standardizeRow] Standardizing row Sl: ${updatedRow.Sl}`);

  

  const instances = parseFloat(updatedRow['No. of Instances']);
  updatedRow['No. of Instances'] = isNaN(instances) ? '0.00' : instances.toFixed(2);

 

  // vCPUs
  updatedRow['vCPUs'] = updatedRow['vCPUs'] || 0;

  // RAM
  updatedRow['RAM'] = updatedRow['RAM'] || 0;

  updatedRow['Datacenter Location'] = updatedRow['Datacenter Location'] || 'ap-south1';

  updatedRow['Avg no. of hrs'] = updatedRow['Avg no. of hrs'] || 730;

  updatedRow["Cloud SQL"] = updatedRow["Cloud SQL"] || "Enterprise";

  updatedRow['Instance Type'] = updatedRow['Instance Type'] || "Custom machine type";

  return updatedRow;
}

module.exports = { standardizeRow };
