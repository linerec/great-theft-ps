// SPDX-License-Identifier: AGPL-3.0-only
//
// Korean for the sentences of one part of the program (see index.ts): the English sentence as the key.
//
// The bridge's words: what it says while it connects to a console and why a connection failed (src/bridge/ps5-link.ts), the
// time limit (src/bridge/server.ts) and how the page explains why its connection closed (web/bridge-client.ts). A console's
// name is put in front of a noun ("{name} 콘솔이") or before 에/에서/의, so the particle is right for any name.

export const KO_BRIDGE: Record<string, string> = {
  // Before anything is tried
  'No PS5 is registered. Register a console first.': '등록된 PS5가 없습니다. 먼저 콘솔을 등록하세요.',
  'The registration of the chosen console is not on this computer.': '선택한 콘솔의 등록 정보가 이 컴퓨터에 없습니다.',
  'The registration could not be read.': '등록 정보를 읽지 못했습니다.',

  // Finding and waking the console
  'Found that the address of {name} has changed': '{name}의 주소가 바뀐 것을 찾았습니다',
  '{name} is in rest mode. Waking it up': '{name} 콘솔이 대기 모드입니다. 깨우는 중입니다',
  'Waking {name} up ({seconds} s)': '{name} 콘솔을 깨우는 중입니다 ({seconds}초)',
  '{name} is starting up ({seconds} s)': '{name} 콘솔이 켜지는 중입니다 ({seconds}초)',
  'Could not wake {name}. {detail}': '{name} 콘솔을 깨우지 못했습니다. {detail}',
  '{name} did not wake up after {seconds} s. Check that "Enable Turning On PS5 from Network" is on (PS5 Settings > System > Power Saving > Features Available in Rest Mode) and that you are on the same home network.':
    '{name} 콘솔이 {seconds}초가 지나도 깨어나지 않았습니다. PS5의 설정 > 시스템 > 절전 > 대기 모드에서 사용할 수 있는 기능에서 "네트워크에서 PS5 켜기 활성화"가 켜져 있는지, 같은 집 네트워크인지 확인하세요.',
  '{name} is on ({seconds} s). Connecting': '{name} 콘솔이 켜졌습니다 ({seconds}초). 연결합니다',

  // The session
  'Asking {name} for a session': '{name}에 세션을 요청하는 중',
  '{name} did not answer on the control connection. Connecting again from the start': '{name} 콘솔이 제어 연결에 답하지 않아 처음부터 다시 연결하는 중',
  '{name} is not answering. It may be off or in rest mode, or its address may have changed. ({detail})':
    '{name} 콘솔이 응답하지 않습니다. 꺼져 있거나 대기 모드이거나, 주소가 바뀌었을 수 있습니다. ({detail})',
  '{name} did not accept the session. {detail}': '{name} 콘솔이 세션을 받아들이지 않았습니다. {detail}',
  'Remote Play is already in use on {name}. If an app other than Great Theft P.S (the official app, chiaki and so on) is connected, disconnect it there.':
    '{name}에서 원격 플레이가 이미 사용 중입니다. Great Theft P.S가 아닌 앱(공식 앱, chiaki 등)이 연결 중이면 그쪽에서 끊어야 합니다.',
  'The console is in use on {device} and locked. Unlock it or disconnect it on that device, and you can take it over.':
    '{device}에서 잠금 상태로 사용 중입니다. 그 기기에서 잠금을 풀거나 연결을 끊으면 가져올 수 있습니다.',
  '{device} let go of the console. Waiting while {name} cleans up that connection ({asked}/{retries})':
    '{device} 기기가 자리를 내주었습니다. {name} 콘솔이 그 연결을 정리하는 동안 기다립니다 ({asked}/{retries})',
  '{name} is clearing up the earlier Remote Play connection (up to about 30 s). Trying again ({asked}/{retries})':
    '{name} 콘솔이 앞선 원격 플레이 연결을 정리하는 중입니다 (길면 30초쯤). 다시 시도합니다 ({asked}/{retries})',
  '{name} accepted the session request. Opening the control connection': '{name} 콘솔이 세션 요청을 받아들였습니다. 제어 연결을 여는 중',

  // The control connection and the stream
  'The account on {name} is protected by a login PIN, so the console asks for it. That is not supported yet.':
    '{name}의 계정에 로그인 암호(PIN)가 걸려 있어 콘솔이 암호를 요구합니다. 아직 지원하지 않습니다.',
  'Could not open the control connection to {name}. {detail}': '{name} 콘솔과 제어 연결을 열지 못했습니다. {detail}',
  'The control connection was lost ({reason})': '제어 연결이 끊어졌습니다 ({reason})',
  'The control connection is open. Opening the video stream': '제어 연결이 열렸습니다. 영상 스트림을 여는 중',
  'Could not open the video stream to {name}. {detail} [{code}]': '{name} 콘솔과 영상 스트림을 열지 못했습니다. {detail} [{code}]',
  'Handed the console over to your other device ({device}).': '다른 내 기기({device})에 자리를 내주었습니다.',
  'no profiles': '프로필 없음',

  // Time per day (server.ts, and the page when the connection closes for it)
  'You have used all your time for today': '오늘 사용할 수 있는 시간을 모두 썼습니다',
  'Your time for today has ended': '오늘 사용할 수 있는 시간이 끝났습니다',

  // Why the page's connection closed (bridge-client.ts)
  'You need to log in. Reloading the page opens the login window. (If the bridge needs a token, open the address the bridge printed)':
    '로그인이 필요합니다. 페이지를 새로 고치면 로그인 창이 열립니다. (토큰이 필요한 브리지라면 브리지가 출력한 주소로 여세요)',
};
