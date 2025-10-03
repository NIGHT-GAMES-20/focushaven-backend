import dotenv from 'dotenv';
dotenv.config();

async function perspectiveAPI(text) {
  try {
    const perspectiveUrl = `https://commentanalyzer.googleapis.com/v1alpha1/comments:analyze?key=${process.env['PERSPECTIVE_API_KEY']}`;
    const response = await fetch(perspectiveUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        comment: { text },
        languages: ['en'],
        requestedAttributes: {
          TOXICITY: {},
          INSULT: {},
          THREAT: {},
          PROFANITY: {},
          SEVERE_TOXICITY: {},
          IDENTITY_ATTACK: {},
          SEXUALLY_EXPLICIT: {},
          FLIRTATION: {}
        }
      })
    });

    const data = await response.json();
    if (!data.attributeScores) return {}; // fallback in case of bad result

    // Extract scores only
    const scores = {};
    for (const attr in data.attributeScores) {
      scores[attr] = Number(data.attributeScores[attr].summaryScore.value.toFixed(3));
    }

    return scores;

  } catch (error) {
    console.error('Error calling Perspective API:', error);
    return { error: 'Perspective API call failed' };
  }
}
export async function analyzeContent(inputs) {

  try{
    const attributes = [
      'TOXICITY',
      'INSULT',
      'THREAT',
      'PROFANITY',
      'SEVERE_TOXICITY',
      'IDENTITY_ATTACK',
      'SEXUALLY_EXPLICIT',
      'FLIRTATION'
    ];

    // 1. Initialize totals
    const attrTotals = {};
    const attrCounts = {};
    for (const attr of attributes) {
      attrTotals[attr] = 0;
      attrCounts[attr] = 0;
    }

    // 2. Analyze all inputs (title, body, tags)
    if (typeof inputs === 'string') {
      inputs = [inputs]; // ensure inputs is an array
    }

    for (const input of inputs) {
      const scores = await perspectiveAPI(input);
      for (const attr of attributes) {
        if (scores[attr] !== undefined) {
          const amplified = Math.pow(scores[attr], 0.65); // deaamplifies high values for better averaging
          attrTotals[attr] += amplified;
          attrCounts[attr] += 1;
        }
      }
    }

    // 3. Compute amplified averages
    const attrAverages = {};
    for (const attr of attributes) {
      if (attrCounts[attr] > 0) {
        const avgAmplified = attrTotals[attr] / attrCounts[attr];
        attrAverages[attr] = Number(avgAmplified.toFixed(3));
      } else {
        attrAverages[attr] = 0;
      }
    }

    // 4. Compute total harm score (weighted sum)
    const attributeWeights = {
      TOXICITY: 1.0,
      INSULT: 1.0,
      THREAT: 1.2,
      PROFANITY: 0.8,
      SEVERE_TOXICITY: 1.5,
      IDENTITY_ATTACK: 1.2,
      SEXUALLY_EXPLICIT: 1.0,
      FLIRTATION: 0.1
    };

    let harmScore = 0;
    for (const attr of attributes) {
      const avg = attrAverages[attr];
      const weight = attributeWeights[attr] || 1.0;
      harmScore += avg * weight;
    }
    harmScore = Number(harmScore.toFixed(3));

    const flaggedAttributes = Object.entries(attrAverages)
      .filter(([_, avg]) => avg > 0.5) // per-attribute threshold
      .map(([attr, avg]) => ({ attribute: attr, avg }));

    return {
      success: true,
      inputs,
      harmScore,
      attrAverages,
      flaggedAttributes
    };
  } catch (error) {
    return {
      success: false,
      message: 'Error analyzing content',
      error: error
    };
  }
}