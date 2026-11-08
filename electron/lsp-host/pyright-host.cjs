// Runs inside an Electron utility process (works with the RunAsNode fuse off). There is no stdin and no
// process.send here, so pyright's `--node-ipc` transport is bridged to the parent's message port: messages are
// LSP JSON objects in both directions and no socket is opened. argv[2] is pyright's langserver script.
'use strict'

const script = process.argv[2]
const port = process.parentPort
process.send = (message, _handle, _options, callback) => {
  port.postMessage(message)
  const cb = [_handle, _options, callback].find(a => typeof a === 'function')
  if (cb) cb(null)
  return true
}
process.connected = true
port.on('message', e => process.emit('message', e.data))
process.argv = [process.argv[0], script, '--node-ipc']
require(script)
