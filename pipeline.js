#!/usr/bin/env node

const { execSync } = require("child_process");

/**
 * Deploy script that processes commits from environment variables
 * and sets deployment flags based on changed files
 */

function processCommits() {
  // Get commits from environment variable
  const commitsEnv = process.env.commits;

  if (!commitsEnv) {
    console.log("No commits environment variable found");
    return;
  }

  let commits;
  try {
    commits = JSON.parse(commitsEnv);
  } catch (error) {
    console.error("Error parsing commits JSON:", error.message);
    return;
  }

  if (!Array.isArray(commits)) {
    console.error("Commits should be an array");
    return;
  }

  const functionNames = new Set();
  let deployClient = false;

  // Process each commit
  commits.forEach((commit) => {
    console.log(`Processing commit: ${commit.id} - ${commit.message}`);

    // Get all changed files from added, modified, and removed arrays
    const changedFiles = [
      ...(commit.added || []),
      ...(commit.modified || []),
      ...(commit.removed || []),
    ];

    changedFiles.forEach((file) => {
      console.log(`Checking file: ${file}`);

      // Check if file is in functions directory
      const functionMatch = file.match(/^functions\/([^\/]+)\//);
      if (functionMatch) {
        const functionName = functionMatch[1];
        functionNames.add(functionName);
      }

      // Check if file is in client directory
      //   if (file.startsWith("client/")) {
      //     deployClient = true;
      //   }
    });
  });

  // Set environment variables for deployment
  const functionsArray = Array.from(functionNames);

  if (functionsArray.length > 0) {
    process.env.DEPLOY_FUNCTIONS = JSON.stringify(functionsArray);
  }

  if (deployClient) {
    process.env.DEPLOY_CLIENT = "true";
  }

  // Output summary
  console.log("\n=== Deployment Summary ===");
  console.log(
    `Functions to deploy: ${functionsArray.length > 0 ? functionsArray.join(", ") : "None"}`,
  );
  console.log(`Deploy client: ${deployClient ? "Yes" : "No"}`);

  // Execute deployment commands
  deployResources(functionsArray, deployClient);

  return {
    functions: functionsArray,
    deployClient: deployClient,
  };
}

/**
 * Execute deployment commands based on the resources to deploy
 */
function deployResources(functions, deployClient) {
  console.log("\n=== Starting Deployment ===");

  let deploymentSuccess = true;

  // Deploy functions
  if (functions.length > 0) {
    console.log(
      `📦 Deploying ${functions.length} function(s): ${functions.join(", ")}`,
    );

    try {
      let functionsArgs = "";
      functions.forEach((functionName) => {
        functionsArgs += `functions:${functionName},`;
      });
      functionsArgs = functionsArgs.slice(0, -1); // Remove trailing comma

      console.log(
        `🚀 Executing command: catalyst deploy --only ${functionsArgs}`,
      );
      execSync(`catalyst deploy --only ${functionsArgs}`, { stdio: "inherit" });
      console.log(
        `✅ Successfully deployed functions: ${functions.join(", ")}`,
      );
    } catch (error) {
      console.error(`❌ Failed to deploy functions: ${error.message}`);
      console.error(`❌ Error details: ${error.stack || error}`);
      deploymentSuccess = false;
    }
  }

  // Deploy client
  if (deployClient) {
    console.log("🌐 Deploying client...");

    try {
      console.log("🚀 Executing command: catalyst deploy --only client");
      execSync("catalyst deploy --only client", { stdio: "inherit" });
      console.log("✅ Successfully deployed client");
    } catch (error) {
      console.error(`❌ Failed to deploy client: ${error.message}`);
      console.error(`❌ Error details: ${error.stack || error}`);
      deploymentSuccess = false;
    }
  }

  // Final status report
  if (functions.length === 0 && !deployClient) {
    console.log(
      "ℹ️  No deployment needed - no functions or client changes detected",
    );
  } else if (deploymentSuccess) {
    console.log("\n🎉 Deployment completed successfully!");
    console.log(`📊 Deployment Summary:`);
    if (functions.length > 0) {
      console.log(
        `   - Functions deployed: ${functions.length} (${functions.join(", ")})`,
      );
    }
    if (deployClient) {
      console.log(`   - Client deployed: Yes`);
    }
  } else {
    console.error(
      "\n💥 Deployment failed! Please check the error messages above.",
    );
    process.exit(1);
  }
}

// Run the script if called directly
if (require.main === module) {
  processCommits();
}

module.exports = { processCommits, deployResources };
