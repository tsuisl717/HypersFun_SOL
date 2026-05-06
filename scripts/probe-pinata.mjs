/**
 * List recent pins on the Pinata account configured via PINATA_JWT.
 *   node scripts/probe-pinata.mjs
 */
process.loadEnvFile('.env');

const JWT = process.env.PINATA_JWT;
if (!JWT) { console.error('Missing PINATA_JWT in .env'); process.exit(1); }

const res = await fetch('https://api.pinata.cloud/data/pinList?status=pinned&pageLimit=15', {
  headers: { Authorization: `Bearer ${JWT}` },
});
if (!res.ok) {
  console.error('Pinata error:', res.status, await res.text());
  process.exit(1);
}
const json = await res.json();
console.log(`Total pinned: ${json.count}\n`);
console.log('Most recent pins:');
for (const row of json.rows ?? []) {
  console.log(
    `  ${row.date_pinned}  ${row.metadata?.name ?? '-'}  ${row.size}B`,
  );
  console.log(`    ipfs://${row.ipfs_pin_hash}`);
}
