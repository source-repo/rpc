/**
 * Wait for something to accept TCP on a port, or fail saying what never arrived.
 *
 *   node tools/wait-for-port.mjs 1883 "MQTT broker"
 *   node tools/wait-for-port.mjs 5217 "SignalR hub" 60
 *
 * This exists because CI starts three things that are not ready when the step that started them
 * returns - a service container, and a hub on each of two platforms - and a suite that begins
 * against a half-bound port fails as a dozen puzzling test errors rather than as one clear message.
 * Keeping the wait in one place also keeps it identical on Windows, where the shell is PowerShell
 * and the node one-liner this replaces would have had to be rewritten in it.
 *
 * Node rather than a shell loop for exactly that reason: it is the one interpreter both runners
 * already have, and it behaves the same on both.
 */

const [, , portArg, label = `port ${portArg}`, secondsArg = '60'] = process.argv

const port = Number(portArg)
const seconds = Number(secondsArg)
if (!Number.isInteger(port) || port <= 0 || !Number.isFinite(seconds)) {
    console.error('usage: node tools/wait-for-port.mjs <port> [label] [seconds]')
    process.exit(2)
}

const { connect } = await import('node:net')
const deadline = Date.now() + seconds * 1000

const attempt = () => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
        socket.end()
        console.log(`${label} is up on ${port}`)
        process.exit(0)
    })
    socket.once('error', () => {
        socket.destroy()
        if (Date.now() > deadline) {
            // Named rather than numbered: "no SignalR hub on 5217 after 60s" is a sentence somebody
            // can act on, where a bare ECONNREFUSED in a log is a thing to go and investigate.
            console.error(`no ${label} on ${port} after ${seconds}s`)
            process.exit(1)
        }
        setTimeout(attempt, 500)
    })
}

attempt()
