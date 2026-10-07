#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <ftw.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <lzma.h>

/* QOS transports at most 128 MiB per boot message. Keep the approved pivot
 * compressed; unpack one bounded inner executable and supervise its lifetime.
 * The approved outer digest binds the XZ bytes; XZ also checks its checksum. */
static volatile sig_atomic_t child_pid = 0;
static volatile sig_atomic_t stopping = 0;
static void stop(int signal_number) {
    stopping = 1;
    if (child_pid > 0) kill(-child_pid, signal_number == SIGALRM ? SIGKILL : signal_number);
    if (signal_number != SIGALRM) alarm(15);
}
static uint64_t little64(const unsigned char *bytes) {
    uint64_t value = 0;
    for (int i = 7; i >= 0; --i) value = (value << 8) | bytes[i];
    return value;
}
static int unpack(int source, int output, uint64_t compressed, uint64_t expected) {
    unsigned char input[65536], buffer[65536];
    lzma_stream stream = LZMA_STREAM_INIT;
    if (lzma_stream_decoder(&stream, 64 * 1024 * 1024, 0) != LZMA_OK) return -1;
    uint64_t total = 0;
    int result = -1;
    while (!stopping) {
        if (stream.avail_in == 0 && compressed) {
            size_t amount = compressed < sizeof(input) ? (size_t)compressed : sizeof(input);
            ssize_t count = read(source, input, amount);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) break;
            compressed -= (uint64_t)count;
            stream.next_in = input; stream.avail_in = (size_t)count;
        }
        stream.next_out = buffer; stream.avail_out = sizeof(buffer);
        lzma_ret status = lzma_code(&stream, LZMA_RUN);
        size_t produced = sizeof(buffer) - stream.avail_out;
        total += produced;
        if (total > expected) break;
        size_t written = 0;
        while (written < produced && !stopping) {
            ssize_t count = write(output, buffer + written, produced - written);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) goto done;
            written += (size_t)count;
        }
        if (status == LZMA_STREAM_END) {
            if (!stopping && !compressed && !stream.avail_in && total == expected) result = 0;
            break;
        }
        if (status != LZMA_OK || (!produced && !stream.avail_in && !compressed)) break;
    }
done:
    lzma_end(&stream);
    return result;
}
static int remove_private_entry(const char *name, const struct stat *info, int kind, struct FTW *walk) {
    (void)info; (void)kind; (void)walk;
    return remove(name);
}
int main(int argc, char **argv) {
    (void)argc;
    int result = 1, source = -1, output = -1, status = 0, directory_created = 0;
    const char *stage = "opening executable";
    char directory[PATH_MAX] = {0}, payload[PATH_MAX] = {0}, executable[PATH_MAX];
    struct stat info;
    unsigned char footer[40];
    struct sigaction action = { .sa_handler = stop };
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL); sigaction(SIGTERM, &action, NULL); sigaction(SIGALRM, &action, NULL);
    source = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    if (source < 0 || fstat(source, &info) || info.st_size < 4096 || info.st_size >= 127 * 1024 * 1024) goto done;
    stage = "reading footer";
    if (pread(source, footer, sizeof(footer), info.st_size - sizeof(footer)) != sizeof(footer) ||
        memcmp(footer, "OPENPOND_XZ_V1!!", 16)) goto done;
    stage = "validating payload bounds";
    uint64_t offset = little64(footer + 16), compressed = little64(footer + 24), expected = little64(footer + 32);
    if (offset < 4096 || offset > (uint64_t)info.st_size - 40 ||
        compressed != (uint64_t)info.st_size - offset - 40 || !expected || expected > 256 * 1024 * 1024) goto done;
    // QOS mounts /tmp, /run and /dev/shm noexec. The approved pivot's
    // filesystem is executable; keep the private unpack directory beside it.
    stage = "locating executable filesystem";
    ssize_t path_length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (path_length <= 0 || path_length >= (ssize_t)sizeof(executable) - 1) goto done;
    executable[path_length] = '\0';
    char *slash = strrchr(executable, '/');
    if (!slash) goto done;
    *slash = '\0';
    if (snprintf(directory, sizeof(directory), "%s/openpond-package-XXXXXX", executable) >= (int)sizeof(directory)) goto done;
    stage = "creating temporary directory";
    if (!mkdtemp(directory)) goto done;
    directory_created = 1;
    if (snprintf(payload, sizeof(payload), "%s/runtime", directory) >= (int)sizeof(payload)) goto done;
    stage = "extracting runtime";
    output = open(payload, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (output < 0 || lseek(source, (off_t)offset, SEEK_SET) < 0 || unpack(source, output, compressed, expected) || fchmod(output, 0700)) goto done;
    close(output); output = -1; close(source); source = -1;
    if (stopping) goto done;
    stage = "running runtime";
    sigset_t blocked, previous;
    sigemptyset(&blocked); sigaddset(&blocked, SIGINT); sigaddset(&blocked, SIGTERM);
    sigprocmask(SIG_BLOCK, &blocked, &previous);
    pid_t child = fork();
    if (child == 0) {
        setpgid(0, 0);
        signal(SIGINT, SIG_DFL); signal(SIGTERM, SIG_DFL); signal(SIGALRM, SIG_DFL);
        sigprocmask(SIG_SETMASK, &previous, NULL);
        if (setenv("TMPDIR", directory, 1)) _exit(127);
        argv[0] = payload;
        execv(payload, argv);
        perror("Embedded runtime exec failed");
        _exit(127);
    }
    child_pid = child > 0 ? child : 0;
    if (child > 0) setpgid(child, child);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    if (child < 0) goto done;
    while (waitpid(child, &status, 0) < 0) { if (errno != EINTR) goto done; }
    // Reap the process group if a startup failure left an inference child.
    kill(-child, SIGKILL); child_pid = 0;
    result = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
done:
    if (output >= 0) close(output);
    if (source >= 0) close(source);
    if (directory_created) nftw(directory, remove_private_entry, 16, FTW_DEPTH | FTW_PHYS);
    if (result && !stopping) fprintf(stderr, "Embedded package startup failed at %s (errno=%d, result=%d).\n", stage, errno, result);
    return result;
}
