import { BrowserDriver } from "./src/browser-driver";
import { writeFileSync } from "fs";
import { join } from "path";

const rawHtml = `<html>
  <head>
    <title>Browser Driver Offline Test</title>
  </head>
  <body style="background:#09090b; color:#f4f4f5; font-family:sans-serif; padding:50px; text-align:center;">
    <h1 style="color:#ffffff;">Standalone BrowserDriver Test</h1>
    <p style="color:#a1a1aa; margin-bottom:30px;">Testing animated visual pointer, click, and typing actions.</p>
    
    <div style="margin:20px auto; max-width:400px; padding:20px; background:#18181b; border:1px solid #27272a; border-radius:12px;">
      <input id="my-input" placeholder="Enter test query..." style="width:100%; padding:10px 14px; box-sizing:border-box; border-radius:6px; border:1px solid #27272a; background:#09090b; color:#fff; font-size:14px; margin-bottom:15px; outline:none;" />
      
      <button id="my-btn" onclick="document.getElementById('output').innerText = 'Success! User typed: ' + document.getElementById('my-input').value" style="width:100%; padding:10px; border-radius:6px; border:none; background:#7aa2f7; color:#1a1b26; font-weight:bold; cursor:pointer; font-size:14px;">
        Trigger Action
      </button>
    </div>
    
    <div id="output" style="margin-top:20px; font-weight:bold; font-size:16px; color:#22c55e;">(waiting...)</div>
  </body>
</html>`;

const htmlPayload = `data:text/html;charset=utf-8,${encodeURIComponent(rawHtml)}`;

async function runTest() {
  console.log("Initializing Standalone BrowserDriver...");
  const driver = new BrowserDriver({
    remoteDebuggingPort: 9333, // Use custom port to avoid conflict with running instances
  });

  try {
    console.log("Launching browser and starting CDP connection...");
    await driver.launch();
    console.log("Browser launched successfully.");

    console.log("Navigating to offline test data page...");
    const nav = await driver.navigate(htmlPayload);
    console.log(`Page Loaded. Title: "${nav.title}", URL: ${nav.url.slice(0, 45)}...`);

    // Verify elements are queryable
    console.log("Listing interactive elements on the page:");
    const elements = await driver.elements();
    console.log(elements);

    // Perform Type action (animates pointer, focuses, and types)
    console.log("Typing into input...");
    const typeRes = await driver.type("#my-input", "Gemini 3.5 Flash");
    console.log(typeRes);

    // Perform Click action (animates pointer, highlights, clicks button)
    console.log("Clicking action button...");
    const clickRes = await driver.click("#my-btn");
    console.log(clickRes);

    // Read modified text
    console.log("Reading page body text to verify changes...");
    const pageText = await driver.readText();
    if (pageText.includes("Success! User typed: Gemini 3.5 Flash")) {
      console.log("  ✓ SUCCESS: Page state updated correctly after click & type.");
    } else {
      console.log("  ✗ FAILURE: Page state did not contain expected success text.");
    }

    // Capture screenshot to confirm pointer overlay position and outline highlight
    console.log("Capturing page screenshot...");
    const b64Data = await driver.screenshot();
    const dest = join(__dirname, "browser-driver-test-result.png");
    writeFileSync(dest, Buffer.from(b64Data, "base64"));
    console.log(`  ✓ Screenshot saved successfully to: ${dest}`);

  } catch (err: any) {
    console.error("Test encountered an error:", err);
  } finally {
    console.log("Closing browser...");
    await driver.close();
    console.log("Browser closed. Test finished.");
  }
}

runTest();
