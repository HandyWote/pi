# pi-profile

Manage gateway profiles from pi and compile them into the official `models.json` format.

Install:

```bash
pi install npm:@handy_wote/pi-profile
```

Open `/profile` to create a profile, save its API key in pi official `auth.json`, discover models, choose enabled models, and edit model capabilities. The extension uses pi native API names and configuration fields.

Profile declarations are stored in `~/.pi/agent/profile-state.json`. Enabled models are compiled into `~/.pi/agent/models.json`; existing user providers are preserved. The current model is selected through pi native `/model`.
