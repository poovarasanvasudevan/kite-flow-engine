exports.nodes = [{
  definition: {
    type: 'uppercase', label: 'Uppercase', category: 'Custom', color: '#f5c9bd', icon: 'code',
    inputs: 1, outputs: 1, description: 'Convert msg.payload to upper case.', defaults: {}, fields: []
  },
  run(message, context) {
    message.payload = String(message.payload ?? '').toUpperCase();
    context.send(0, message);
  }
}];
