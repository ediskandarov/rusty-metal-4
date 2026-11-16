#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cond = PTHREAD_COND_INITIALIZER;
static int ready;
static int (*probe)(void);

static void* worker(void* arg)
{
    (void)arg;
    pthread_mutex_lock(&mutex);
    while (!ready)
        pthread_cond_wait(&cond, &mutex);
    assert(probe() == 2);
    pthread_mutex_unlock(&mutex);
    return NULL;
}

int main(void)
{
    pthread_t thread;
    assert(!pthread_create(&thread, NULL, worker, NULL));
    void* lib = dlopen("first.wasm", RTLD_NOW | RTLD_LOCAL);
    assert(lib);
    // The same export name in another RTLD_LOCAL module must get its own table entry.
    lib = dlopen("second.wasm", RTLD_NOW | RTLD_LOCAL);
    assert(lib);
    probe = dlsym(lib, "answer");
    assert(probe && probe() == 2);
    pthread_mutex_lock(&mutex);
    ready = 1;
    pthread_cond_signal(&cond);
    pthread_mutex_unlock(&mutex);
    assert(!pthread_join(thread, NULL));
    puts("PASS: dlsym catch-up called the second module on both threads");
    return 0;
}
