# Changelog

## 2.0.1

- Fixed: clipboard sync didn't send anything from Mac or Windows. PhoneDrop now uses Electron's newer, asynchronous
  clipboard calls for reading and writing text and images.

## 2.0.0

PhoneDrop now runs on **Mac and Windows**, shares your **clipboard**, and works **away from home**.

- **Mac app**: lives in the menu bar; drop files on the menu-bar icon to send them
- **Shared clipboard**: copied text and images sync between your computers automatically; on iPhone and iPad, tap
  **Send my clipboard**, or tap something your computer copied to copy it. Pause it from the popup or tray menu
- **Every device can send to every device**: computers show up as bubbles too, and the phone page shows your computers as bubbles
  to send to
- **Away from home over Tailscale**: devices learn the hub's Tailscale address at home, connect through it when you're out, and
  switch back to Wi-Fi when you're home
- **Encrypted end to end** with a passphrase that never leaves your devices; the hub only accepts your home network and tailnet
- One computer runs the **hub**; choose it in the new **Settings** panel
- The iPhone/iPad page is now an installable app (add to home screen) that also opens away from home
- iPhone and iPad need a one-time certificate install, so the browser allows encryption and clipboard access
- Received files show who sent them; a new *Sent* list shows what you sent and to which device

## 1.1.0

- iPad is now a supported device. It shows up as its own "iPad" bubble (iPadOS Safari pretends to be a Mac, so the page now tells PhoneDrop what it really is), and the page is laid out for the larger screen
- Several devices can be connected at once
- Fixed the file lists overlapping the device bubble in the popup

## 1.0.0

First release.

- Send files iPhone → PC and PC → iPhone over your local Wi-Fi, no iPhone app needed
- System tray popup that opens on click and closes when you click away (with a Pin button)
- Devices appear automatically as bubbles; drop files on them or click to choose
- Thumbnails and a large preview for received images
- Dark UI with animated rings
- Starts with Windows (toggle from the tray menu)
- Windows installer (unsigned)
