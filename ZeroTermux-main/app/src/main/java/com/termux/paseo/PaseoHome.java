package com.termux.paseo;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Single source of truth for Paseo's {@code $HOME}.
 *
 * <p>Paseo used to run out of {@code files/paseo-home} while Termux sessions ran out of
 * {@code files/home}. Two homes meant the terminal a user opened was never the directory
 * their agent was working in: agent state, npm globals, CLI credentials and shell dotfiles
 * all landed on one side of the split.
 *
 * <p>The two are now unified on {@code files/home}, which is {@link
 * com.termux.shared.termux.TermuxConstants#TERMUX_HOME_DIR_PATH}. That direction was chosen
 * over moving Termux because the Paseo runtime scripts are all {@code $HOME}-relative
 * ({@code $HOME/.paseo-app}) and follow automatically, whereas the Termux and ZeroTermux
 * surface hardcodes {@code files/home} in dozens of scripts, layouts and string resources
 * that would otherwise split again.
 */
public final class PaseoHome {

    /** Directory name Paseo used before the homes were unified. */
    private static final String LEGACY_HOME_NAME = "paseo-home";
    /** Unified home directory name, matching TermuxConstants.TERMUX_HOME_DIR_PATH. */
    private static final String HOME_NAME = "home";

    private PaseoHome() {}

    /** @return the unified {@code $HOME} directory for both Paseo and Termux sessions. */
    public static File directory(File filesDirectory) {
        return new File(filesDirectory, HOME_NAME);
    }

    /** @return the Paseo runtime's private state directory inside {@link #directory}. */
    public static File appDirectory(File filesDirectory) {
        return new File(directory(filesDirectory), ".paseo-app");
    }

    /**
     * Moves anything left in the pre-unification {@code files/paseo-home} into the unified
     * home. Safe to call on every start: it does nothing once the legacy directory is gone.
     *
     * <p>Entries already present in the unified home win, so a repeated or partial migration
     * never overwrites live state. Whatever cannot be moved is left in place rather than
     * deleted, so no user data is lost if the migration is incomplete.
     *
     * <p>Kept free of {@code android.util.Log} so it stays unit testable; anything worth
     * reporting comes back as a message for the caller to log.
     *
     * @return one message per problem encountered. An empty list means the legacy directory
     *         was absent or has been fully migrated and removed.
     */
    public static List<String> migrateLegacyHome(File filesDirectory) {
        File legacy = new File(filesDirectory, LEGACY_HOME_NAME);
        if (!legacy.isDirectory()) return Collections.emptyList();

        List<String> problems = new ArrayList<>();
        File unified = directory(filesDirectory);
        if (!unified.isDirectory() && !unified.mkdirs()) {
            problems.add("Could not create the unified home at " + unified.getAbsolutePath());
            return problems;
        }

        File[] entries = legacy.listFiles();
        if (entries == null) {
            problems.add("Could not list the legacy home at " + legacy.getAbsolutePath());
            return problems;
        }

        for (File entry : entries) {
            File target = new File(unified, entry.getName());
            if (target.exists()) {
                // The unified home already owns this name; leave the legacy copy behind for
                // the user to inspect instead of merging blindly.
                problems.add("Kept existing " + target.getAbsolutePath()
                    + "; the legacy copy stays at " + entry.getAbsolutePath());
                continue;
            }
            if (!entry.renameTo(target)) {
                problems.add("Could not move " + entry.getAbsolutePath()
                    + " to " + target.getAbsolutePath());
            }
        }

        problems.addAll(rewriteLegacyPaths(legacy, unified));

        if (problems.isEmpty() && !legacy.delete()) {
            problems.add("Migrated everything but could not remove " + legacy.getAbsolutePath());
        }
        return problems;
    }

    /**
     * Repoints absolute paths that the Agent CLI state recorded under the legacy home.
     *
     * <p>Moving the files is not enough: the state file stores the absolute path of every
     * installed CLI, and each consumer validates those against an install root derived from the
     * current {@code $HOME}. Left alone, a perfectly good install reads as missing and the user
     * is told to reinstall.
     *
     * <p>The server repairs this on read too, so this pass is belt and braces for the window
     * before the daemon starts, and for the case where the server cannot persist its repair.
     * Only our own state file is touched; user-owned dotfiles are left exactly as they are.
     */
    private static List<String> rewriteLegacyPaths(File legacy, File unified) {
        File agents = new File(new File(unified, ".paseo-app"), "agents");
        File state = new File(agents, "agent-cli-state.json");
        if (!state.isFile()) return Collections.emptyList();

        String legacyPrefix = legacy.getAbsolutePath() + File.separator;
        try {
            String contents = new String(
                Files.readAllBytes(state.toPath()), StandardCharsets.UTF_8);
            if (!contents.contains(legacyPrefix)) return Collections.emptyList();
            String rewritten = contents.replace(legacyPrefix, unified.getAbsolutePath() + File.separator);
            Files.write(state.toPath(), rewritten.getBytes(StandardCharsets.UTF_8));
        } catch (IOException error) {
            // The daemon repairs the same paths when it reads the state, so a failure here only
            // costs the head start, never the install.
            return Collections.singletonList(
                "Could not repoint legacy paths in " + state.getAbsolutePath() + ": " + error);
        }
        return Collections.emptyList();
    }
}
