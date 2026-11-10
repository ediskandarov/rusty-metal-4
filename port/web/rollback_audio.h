#ifndef TM4_WEB_ROLLBACK_AUDIO_H
#define TM4_WEB_ROLLBACK_AUDIO_H

typedef struct SoundEmitter SoundEmitter;

enum { WebAudioPlaybackFinished = -2 };

void WebRollbackAudioReset(void);
void WebRollbackAudioStarted(const SoundEmitter* emitter, int index);
void WebRollbackAudioRemember(void);
void WebRollbackAudioDetach(void);
void WebRollbackAudioReconcile(void);

#endif
