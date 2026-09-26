const http = require('http');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.static(path.join(__dirname)));

const PORT = 3009;
const server = app.listen(PORT, () => {
  http.get(`http://localhost:${PORT}/`, res => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      console.log(`Landing Route Status: HTTP ${res.statusCode}`);
      console.log(`Content-Type: ${res.headers['content-type']}`);
      console.log(`Includes Headline: ${data.includes('Stop Letting OpenAI & Anthropic Token Burn Eat')}`);
      console.log(`Includes Calculator: ${data.includes('calc-results-box')}`);
      console.log(`Includes Stripe Links: ${data.includes('buy.stripe.com')}`);
      console.log(`Includes Strategy Call Booking: ${data.includes('Book 15-Min Strategy Call')}`);
      server.close();
    });
  });
});
