const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
require("dotenv").config();
const { ApiPromise } = require('@polkadot/api');
const { WsProvider } = require('@polkadot/rpc-provider');
const { xxhashAsHex } = require('@polkadot/util-crypto');
const execFileSync = require('child_process').execFileSync;
const execSync = require('child_process').execSync;
const binaryPath = path.join(__dirname, 'data', 'binary');
const schemaPath = path.join(__dirname, 'data', 'schema.json');
const originalSpecPath = path.join(__dirname, 'data', 'genesis.json');
const forkedSpecPath = path.join(__dirname, 'data', 'fork.json');
const storagePath = path.join(__dirname, 'data', 'storage.json');
const pageSize = process.env.PAGE_SIZE || 100;

const provider = new WsProvider(process.env.WS_RPC_ENDPOINT || 'ws://127.0.0.1:9944')
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

const alice = process.env.ALICE || ''
const originalChain = process.env.ORIG_CHAIN || '';
const forkChain = process.env.FORK_CHAIN || '';

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = ['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9' /* System.Account */];

/**
 * skip ParachainSystem module, mainly due to two problems that we encountered:
 * - parachainSystem.lastRelayChainBlockNumber => we use RelayNumberStrictlyIncreases, needs to be reset to 0
 * - parachainSystem.LastDmqMqcHead => expected to be 0
 */
const skippedModulesPrefix = ['Authorship', 'CollatorSelection', 'Session', 'Aura', 'AuraExt', 'ParachainStaking','ParachainSystem','TechnicalCommittee','TechnicalCommitteeMembership','Council','CouncilMembership'];

async function fixParachinStates (api, forkedSpec) {
  const skippedKeys = [
    api.query.parasScheduler.sessionStartBlock.key()
  ];
  for (const k of skippedKeys) {
    delete forkedSpec.genesis.raw.top[k];
  }
}

async function main() {
  if (!fs.existsSync(binaryPath)) {
    console.log(chalk.red('Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'));
    process.exit(1);
  }
  execFileSync('chmod', ['+x', binaryPath]);

  let api;
  console.log(chalk.green('We are intentionally using the WSS endpoint. If you see any warnings about that, please ignore them.'));
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow('Custom Schema missing, using default schema.'));
    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(chalk.yellow('Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage'));
  } else {
    // Download state of original chain
    console.log(chalk.green('Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain.'));
    let at = (await api.rpc.chain.getBlockHash()).toString();
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: 'a' });
    stream.write("[");
    await fetchChunks("0x", chunksLevel, stream, at);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const runtime = (await api.rpc.state.getStorage(":code")).toString();

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = metadata.asLatest.pallets;
  modules.forEach((module) => {
    if (module.storage) {
      if (!skippedModulesPrefix.includes(module.name.toHuman())) {
        prefixes.push(xxhashAsHex(module.name, 128));
      }
    }
  });

  // Generate chain spec for original and forked chains
  if (originalChain == '') {
    execSync(binaryPath + ` build-spec --raw > ` + originalSpecPath);
  } else {
    execSync(binaryPath + ` build-spec --chain ${originalChain} --raw > ` + originalSpecPath);
  }
  if (forkChain == '') {
    execSync(binaryPath + ` build-spec --dev --raw > ` + forkedSpecPath);
  } else {
    execSync(binaryPath + ` build-spec --chain ${forkChain} --raw > ` + forkedSpecPath);
  }

  let storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, 'utf8'));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, 'utf8'));

  // Modify chain name and id
  forkedSpec.name = originalSpec.name + '-fork';
  forkedSpec.id = originalSpec.id + '-fork';
  forkedSpec.protocolId = originalSpec.protocolId;

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8'];

  fixParachinStates(api, forkedSpec);

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top['0x3a636f6465'] = runtime.trim();

  // To prevent the validator set from changing mid-test, set Staking.ForceEra to ForceNone ('0x02')
  forkedSpec.genesis.raw.top['0x5f3e4907f716ac89b6347d15ececedcaf7dad0317324aecae8744b87fc95f2f3'] = '0x02';

  // clear the "flags" in ALICE to use the "old" mode
  // see https://linear.app/litentry/issue/P-262/runtime-upgrade-simulation-fails-to-work
  // to be removed afer the `upgrade_account` is called on the prod chain
  forkedSpec.genesis.raw.top['0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9de1e86a9a8c739864cf3cc5ec2bea59fd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'] = '0x000000000100000001000000000000000080c6a47e8d03000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

  if (alice !== '') {
    // Set sudo key to //Alice
    forkedSpec.genesis.raw.top['0x5c0d1176a568c1f92944340dbfed9e9c530ebca703c85910e7164cb7d1c9e47b'] = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  }

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log('Forked genesis generated successfully. Find it at ./data/fork.json');
  process.exit();
}

main();

async function fetchChunks(prefix, levelsRemaining, stream, at) {
  // replace getpairs with getkeypaged & getstorage
  if (levelsRemaining <= 0) {
      let startKey = null;
      while (true) {
        const keys = await provider.send('state_getKeysPaged', [prefix, pageSize, startKey, at]);
        if (keys.length > 0) {
          let pairs = [];
          await Promise.all(keys.map(async (key) => {
            const value = await provider.send('state_getStorage', [key, at]);
            pairs.push([key, value]);
          }));
  
          separator ? stream.write(",") : separator = true;
          stream.write(JSON.stringify(pairs).slice(1, -1));
  
          startKey = keys[keys.length - 1];
        }
  
        if (keys.length < pageSize) {
          break;
        }
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at));
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(prefix + i.toString(16).padStart(2, "0"), levelsRemaining - 1, stream, at);
    }
  }
}
