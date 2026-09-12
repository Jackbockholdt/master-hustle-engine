const { generateOutreachSequence } = require('./skills/skill4_outreach_copy');

async function sendOneLive() {
  const lead = {
    name: 'Austin Wallace',
    company: 'Marketing Activations Group',
    industry: 'B2B Marketing & Lead Gen Agency',
    useCase: 'outbound lead qualification, cold email generation & multi-tenant CRM workflows',
    email: 'jbockholdt4@gmail.com' // Send to Jack for verification
  };

  const sequenceObj = generateOutreachSequence({ lead });
  const step0 = sequenceObj.sequence[0];

  console.log('--- PRE-FLIGHT CHECK ---');
  console.log('Recipient:', lead.email);
  console.log('Subject:', step0.subject);
  console.log('Contains Landing URL (Render):', step0.body.includes('https://master-hustle-engine.onrender.com'));
  console.log('Contains Shovel URL (missedcallproject):', step0.body.includes('https://www.missedcallproject.com'));
  console.log('Contains $25,000 Stripe Checkout:', step0.body.includes('https://buy.stripe.com/bJecN4al44iL5C7bsX0000H'));
  console.log('Contains Mismatched $25k link on $2,500:', step0.body.includes('$2,500 setup + $1,500/mo)[\s\S]*buy.stripe.com/bJecN4al44iL5C7bsX0000H'));
  console.log('------------------------');

  console.log('[DISPATCHING VIA RENDER HTTPS RELAY]');
  const res = await fetch('https://master-hustle-engine.onrender.com/api/send-single-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: lead.email,
      subject: step0.subject,
      body: step0.body
    })
  });

  const status = res.status;
  const json = await res.json();
  console.log('HTTP Status:', status);
  console.log('Response Payload:', JSON.stringify(json, null, 2));
}

sendOneLive().catch(console.error);
