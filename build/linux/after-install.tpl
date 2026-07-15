#!/bin/bash

# Custom .deb postinst. Mirrors electron-builder's default after-install.tpl
# (binary symlink + mime/desktop database refresh) but ALWAYS gives
# chrome-sandbox the setuid-root bit.
#
# electron-builder's default script probes for user namespaces and skips the
# setuid bit when they appear available. That probe is wrong on Ubuntu 23.10+/
# 24.04: it runs as root at install time, and root can always create user
# namespaces even where the kernel's AppArmor policy
# (kernel.apparmor_restrict_unprivileged_userns=1, default-on since 24.04)
# blocks them for the unprivileged user who actually runs the app. The probe
# then leaves chrome-sandbox non-setuid and the app aborts at launch with
# "The SUID sandbox helper binary ... is not configured correctly".
#
# The SUID sandbox is the universal fallback and works with or without user
# namespaces, so we set it unconditionally. This is exactly what Google
# Chrome's own .deb ships. NOTE: electron-builder expands every dollar-brace
# token in this file as one of its macros (executable, sanitizedProductName,
# productFilename) and throws on any it doesn't recognise — so do not write
# shell variable expansions here, not even inside comments.

if type update-alternatives 2>/dev/null >&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Always ship a setuid-root chrome-sandbox (see header comment).
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox' 2>/dev/null || true
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi
