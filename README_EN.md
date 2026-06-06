Permission Controller v1.9.8

Purpose
Control who can call AstrBot in QQ group chats and private chats.

Main features
- Read joined QQ groups from the bot account.
- Read QQ friends from the bot account.
- Allow an entire group.
- Allow selected users in a group.
- Deny selected users in a group.
- Entire group allow and selected user allow are exclusive.
- Group denied users have the highest priority.
- Private chat QQ user whitelist.
- Frontend page supports plugin call ability settings.
- Plugin list uses checked means enabled.
- Unchecked plugins are not enabled.
- Frontend-only fields are hidden from the backend plugin config panel.
- Some noisy send logs are filtered.

Rules
If entire group allow is enabled, all QQ users in the group can call the bot.
If selected user allow is enabled, only users in the allow list can call the bot.
If denied users are enabled, users in the deny list cannot call the bot.
Denied users override entire group allow and selected user allow.
In the plugin list, checked plugins are enabled and unchecked plugins are disabled.

Usage
1. Install the plugin.
2. Restart or reload AstrBot.
3. Open the plugin settings page.
4. Configure QQ groups or QQ users.
5. Save the configuration.

Notes
- Reloading the plugin after configuration changes is recommended.
- Required group IDs and user IDs are synced to the platform whitelist automatically.
- Frontend-only plugin fields are not shown in the backend config panel.

Version
v1.9.8
