/* Emscripten's standalone libc only opens standard streams. Map its read-only
 * resource opens to a host-provided WASI /DATA preopen, with no JS filesystem. */
#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
#include <wasi/api.h>

static int data_directory(void)
{
    static int found = -1;
    if (found >= 0)
        return found;
    for (int fd = 3; fd < 32; ++fd) {
        __wasi_prestat_t info;
        unsigned char name[5];
        if (!__wasi_fd_prestat_get(fd, &info) && info.u.dir.pr_name_len == sizeof(name)
            && !__wasi_fd_prestat_dir_name(fd, name, sizeof(name))
            && !memcmp(name, "/DATA", sizeof(name))) {
            found = fd;
            return fd;
        }
    }
    return -1;
}

int __syscall_openat(int directory, const char* path, int flags, ...)
{
    if (directory != AT_FDCWD || strncmp(path, "/DATA/", 6) || (flags & O_ACCMODE) != O_RDONLY
        || (flags & (O_CREAT | O_TRUNC | O_APPEND)))
        return -EACCES;
    int parent = data_directory();
    if (parent < 0)
        return -ENOENT;
    __wasi_fd_t opened;
    __wasi_rights_t rights = __WASI_RIGHTS_FD_READ | __WASI_RIGHTS_FD_SEEK | __WASI_RIGHTS_FD_TELL
        | __WASI_RIGHTS_FD_FILESTAT_GET;
    __wasi_errno_t error
        = __wasi_path_open(parent, 0, path + 6, strlen(path + 6), 0, rights, 0, 0, &opened);
    return error ? -(int)error : (int)opened;
}

int __syscall_faccessat(int directory, const char* path, int mode, int flags)
{
    if (mode & ~R_OK || flags)
        return -EACCES;
    int fd = __syscall_openat(directory, path, O_RDONLY);
    if (fd < 0)
        return fd;
    __wasi_errno_t error = __wasi_fd_close(fd);
    return error ? -EIO : 0;
}

int __syscall_unlinkat(int directory, const char* path, int flags)
{
    return -EROFS;
}
