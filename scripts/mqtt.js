const mqtt = require('mqtt')

const url = 'http://localhost:1883'

// Create an MQTT client instance
const options = {
    // Clean session
    clean: true,
    connectTimeout: 4000,
    // Authentication
    clientId: 'centrale_server',
    username: 'centrale_server',
    password: 'Centrale_server123',
    // MQTT broker details
    host: 'localhost',
    port: 1883,
    protocol: 'mqtt',
}
const client = mqtt.connect(url, options)
client.on('connect', function () {
    console.log('Connected')
    // Subscribe to a topic
    client.subscribe('test', function (err) {
        if (!err) {
            // Publish a message to a topic
            client.publish('test', 'Hello mqtt')
        }
    })
})

// Receive messages
client.on('message', function (topic, message) {
    // message is Buffer
    console.log('Topic:', topic)
    console.log('')
    console.log('Received message:', message.toString())

    client.end()
})
