package com.termux.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class TermuxInstallerPrefixTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void minimalPaseoRuntimeIsNotMistakenForAUsableTerminalPrefix() throws Exception {
        File prefix = temporaryFolder.newFolder("usr");
        File bin = new File(prefix, "bin");
        assertTrue(bin.mkdirs());
        assertTrue(new File(bin, "node").createNewFile());

        assertFalse(TermuxInstaller.hasUsableTerminalPrefix(prefix));

        assertTrue(new File(bin, "bash").createNewFile());
        assertTrue(new File(bin, "ls").createNewFile());
        assertTrue(new File(bin, "env").createNewFile());
        assertTrue(TermuxInstaller.hasUsableTerminalPrefix(prefix));
    }
}
