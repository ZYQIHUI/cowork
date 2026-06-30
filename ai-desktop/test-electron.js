const electron = require("electron");
console.log("electron type:", typeof electron);
console.log("electron.app:", typeof electron.app);
if (electron.app) {
  electron.app.whenReady().then(() => {
    console.log("APP READY!");
    electron.app.quit();
  });
} else {
  console.log("FAIL: electron.app is undefined");
  process.exit(1);
}
